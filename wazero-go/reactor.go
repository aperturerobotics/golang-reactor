// Package reactor provides a harness for running Go WASI reactor binaries.
//
// Go programs built with -buildmode=c-shared for wasip1 export _initialize,
// go_start_main, and go_tick functions that allow the host to drive execution
// cooperatively.
//
// Usage:
//
//	r := wazero.NewRuntime(ctx)
//	defer r.Close(ctx)
//
//	reactor, err := NewReactor(ctx, r, wasmBytes, nil)
//	if err != nil {
//	    log.Fatal(err)
//	}
//	defer reactor.Close(ctx)
//
//	if err := reactor.Run(ctx); err != nil {
//	    log.Fatal(err)
//	}
package reactor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// LoopResult represents the return value from go_tick.
type LoopResult int32

const (
	// LoopIdle indicates no pending work; safe to terminate.
	LoopIdle LoopResult = -1
	// LoopReady indicates more goroutines are runnable.
	LoopReady LoopResult = 0
	// Values > 0 indicate milliseconds until next timer.
)

// Config configures a Reactor instance.
type Config struct {
	// Stdin is the reader for stdin. Defaults to os.Stdin.
	Stdin io.Reader
	// Stdout is the writer for stdout. Defaults to os.Stdout.
	Stdout io.Writer
	// Stderr is the writer for stderr. Defaults to os.Stderr.
	Stderr io.Writer
	// Args are command-line arguments. Defaults to ["reactor"].
	Args []string
	// Env are environment variables in "KEY=VALUE" format.
	Env []string
	// FS is the filesystem to mount. If nil, no filesystem is mounted.
	FS wazero.FSConfig
}

// Reactor wraps a Go WASI reactor module and provides methods to drive it.
type Reactor struct {
	runtime wazero.Runtime
	mod     api.Module

	initialize   api.Function
	goStartMain  api.Function
	goTick       api.Function
}

// NewReactor instantiates a Go WASI reactor from the given WASM bytes.
func NewReactor(ctx context.Context, r wazero.Runtime, wasm []byte, cfg *Config) (*Reactor, error) {
	if cfg == nil {
		cfg = &Config{}
	}

	// Set defaults
	stdin := cfg.Stdin
	if stdin == nil {
		stdin = os.Stdin
	}
	stdout := cfg.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := cfg.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}
	args := cfg.Args
	if len(args) == 0 {
		args = []string{"reactor"}
	}

	// Instantiate WASI
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, r); err != nil {
		return nil, fmt.Errorf("instantiate WASI: %w", err)
	}

	// Compile the module
	compiled, err := r.CompileModule(ctx, wasm)
	if err != nil {
		return nil, fmt.Errorf("compile module: %w", err)
	}

	// Configure the module
	modConfig := wazero.NewModuleConfig().
		WithStdin(stdin).
		WithStdout(stdout).
		WithStderr(stderr).
		WithArgs(args...).
		WithStartFunctions() // Don't call _start automatically

	for _, env := range cfg.Env {
		// Parse KEY=VALUE
		for i := 0; i < len(env); i++ {
			if env[i] == '=' {
				modConfig = modConfig.WithEnv(env[:i], env[i+1:])
				break
			}
		}
	}

	if cfg.FS != nil {
		modConfig = modConfig.WithFSConfig(cfg.FS)
	}

	// Instantiate the module
	mod, err := r.InstantiateModule(ctx, compiled, modConfig)
	if err != nil {
		return nil, fmt.Errorf("instantiate module: %w", err)
	}

	// Look up exported functions
	initialize := mod.ExportedFunction("_initialize")
	if initialize == nil {
		mod.Close(ctx)
		return nil, errors.New("module does not export _initialize (not a WASI reactor?)")
	}

	goStartMain := mod.ExportedFunction("go_start_main")
	if goStartMain == nil {
		mod.Close(ctx)
		return nil, errors.New("module does not export go_start_main (not built with modified Go runtime?)")
	}

	goTick := mod.ExportedFunction("go_tick")
	if goTick == nil {
		mod.Close(ctx)
		return nil, errors.New("module does not export go_tick (not built with modified Go runtime?)")
	}

	reactor := &Reactor{
		runtime:     r,
		mod:         mod,
		initialize:  initialize,
		goStartMain: goStartMain,
		goTick:      goTick,
	}

	// Call _initialize
	if _, err := initialize.Call(ctx); err != nil {
		mod.Close(ctx)
		return nil, fmt.Errorf("call _initialize: %w", err)
	}

	return reactor, nil
}

// Close releases resources associated with the reactor.
func (r *Reactor) Close(ctx context.Context) error {
	return r.mod.Close(ctx)
}

// StartMain queues the main goroutine for execution.
// This must be called before Run or LoopOnce.
func (r *Reactor) StartMain(ctx context.Context) error {
	_, err := r.goStartMain.Call(ctx)
	return err
}

// LoopOnce runs one iteration of the Go scheduler.
// Returns the result indicating when to call again.
func (r *Reactor) LoopOnce(ctx context.Context) (LoopResult, error) {
	results, err := r.goTick.Call(ctx)
	if err != nil {
		return LoopIdle, err
	}
	return LoopResult(int32(results[0])), nil
}

// Run executes the reactor until completion.
// It calls StartMain, then loops calling go_tick until idle.
func (r *Reactor) Run(ctx context.Context) error {
	if err := r.StartMain(ctx); err != nil {
		return fmt.Errorf("start main: %w", err)
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		result, err := r.LoopOnce(ctx)
		if err != nil {
			return fmt.Errorf("loop once: %w", err)
		}

		switch {
		case result == LoopIdle:
			return nil
		case result == LoopReady:
			// More work, continue immediately
			continue
		case result > 0:
			// Wait for timer
			timer := time.NewTimer(time.Duration(result) * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
				continue
			}
		}
	}
}

// RunWithCallback executes the reactor, calling onTick before each iteration.
// This allows the host to perform work between scheduler iterations.
func (r *Reactor) RunWithCallback(ctx context.Context, onTick func()) error {
	if err := r.StartMain(ctx); err != nil {
		return fmt.Errorf("start main: %w", err)
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if onTick != nil {
			onTick()
		}

		result, err := r.LoopOnce(ctx)
		if err != nil {
			return fmt.Errorf("loop once: %w", err)
		}

		switch {
		case result == LoopIdle:
			return nil
		case result == LoopReady:
			continue
		case result > 0:
			timer := time.NewTimer(time.Duration(result) * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
				continue
			}
		}
	}
}

// Module returns the underlying wazero module for advanced usage.
func (r *Reactor) Module() api.Module {
	return r.mod
}
