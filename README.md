# golang-reactor

> Host harnesses for Go WASI reactor binaries with cooperative scheduling.

## Related Projects

- [paralin/go (wasi-reactor branch)](https://github.com/paralin/go/tree/wasi-reactor) - Modified Go runtime with WASI reactor support
- [js-quickjs-wasi-reactor](https://github.com/aperturerobotics/js-quickjs-wasi-reactor) - JavaScript harness for QuickJS WASI reactor
- [go-quickjs-wasi-reactor](https://github.com/aperturerobotics/go-quickjs-wasi-reactor) - Go harness for QuickJS WASI reactor

## About

This project provides host harnesses for running Go programs compiled as WASI
reactors with cooperative scheduling. It includes both a Go harness (using
wazero) and a JavaScript/TypeScript harness for browser and Node.js environments.

The harnesses work with Go programs built using a modified Go runtime that
exports `go_start_main()` and `go_tick()` functions for external control of the
Go scheduler.

## WASI Reactor Model

Unlike the standard WASI "command" model where `_start()` runs the program to
completion, the reactor model:

1. Exports `_initialize()` for runtime setup (no main execution)
2. Exports `go_start_main()` to queue the main goroutine
3. Exports `go_tick()` for the host to drive the scheduler

This enables embedding Go in environments that need cooperative control, such as
JavaScript runtimes, game engines, or multi-language WASM hosts.

### go_tick() Return Values

| Value | Meaning |
|-------|---------|
| -1 | Idle - no pending work, safe to terminate |
| 0 | Ready - more goroutines runnable, call again immediately |
| >0 | Timer pending - milliseconds until next scheduled work |

## Packages

### Go Harness (`wazero-go/`)

Uses [wazero](https://wazero.io/) to run Go WASI reactors with full WASI support:

```go
package main

import (
    "context"
    "log"
    "os"

    "github.com/tetratelabs/wazero"
    reactor "github.com/user/golang-reactor/wazero-go"
)

func main() {
    ctx := context.Background()

    wasm, _ := os.ReadFile("program.wasm")

    r := wazero.NewRuntime(ctx)
    defer r.Close(ctx)

    react, _ := reactor.NewReactor(ctx, r, wasm, nil)
    defer react.Close(ctx)

    // Run to completion
    if err := react.Run(ctx); err != nil {
        log.Fatal(err)
    }
}
```

#### Manual Loop Control

For fine-grained control over scheduling:

```go
react.StartMain(ctx)

for {
    result, err := react.LoopOnce(ctx)
    if err != nil {
        return err
    }

    switch {
    case result == reactor.LoopIdle:
        return nil // Done
    case result == reactor.LoopReady:
        continue // More work available
    case result > 0:
        // Timer pending - do other work or wait
        time.Sleep(time.Duration(result) * time.Millisecond)
    }
}
```

### JavaScript/TypeScript Harness (`src/`)

For browser and Node.js/Bun environments:

```typescript
import { createReactor, createMinimalWASI } from "go-reactor";

const wasmBytes = await fetch("program.wasm").then(r => r.arrayBuffer());
const wasmModule = await WebAssembly.compile(wasmBytes);

const wasi = createMinimalWASI({
  args: ["program"],
  stdout: (text) => console.log(text),
  stderr: (text) => console.error(text),
});

const reactor = await createReactor(wasmModule, {
  wasiImports: wasi.wasiImports,
  setMemory: (memory) => wasi.setMemory(memory),
});

// Run to completion with async timer support
await reactor.runAsync();
```

#### Loop Control

```typescript
reactor.startMain();

while (true) {
  const result = reactor.loopOnce();

  if (result === LoopResult.Idle) {
    break; // Done
  }

  if (result === LoopResult.Ready) {
    await Promise.resolve(); // Yield to event loop
    continue;
  }

  if (result > 0) {
    // Wait for timer
    await new Promise(resolve => setTimeout(resolve, result));
  }
}
```

#### Minimal WASI

The `createMinimalWASI()` function provides basic WASI support for:

- Command-line arguments (`args_get`, `args_sizes_get`)
- Environment variables (`environ_get`, `environ_sizes_get`)
- Standard I/O (`fd_write` for stdout/stderr)
- Clocks (`clock_time_get` for realtime and monotonic)
- Random numbers (`random_get`)

For full filesystem and network support, use a complete WASI implementation.

## Building Go Programs

Go programs must be built with the [modified Go runtime](https://github.com/paralin/go/tree/wasi-reactor)
that exports reactor functions.

### Installing the Modified Go Toolchain

```bash
# Clone the fork
git clone -b wasi-reactor https://github.com/paralin/go.git go-wasi-reactor
cd go-wasi-reactor/src

# Build the toolchain
./make.bash

# The built toolchain is at ../bin/go
export PATH="$(pwd)/../bin:$PATH"

# Verify
go version
```

### Compiling a WASI Reactor

```bash
# Build as WASI reactor
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o program.wasm .
```

The `-buildmode=c-shared` flag triggers reactor mode on wasip1, which:

- Exports `_initialize` instead of `_start`
- Exports `go_start_main` and `go_tick` for cooperative scheduling
- Skips automatic main() execution

### Example Program

```go
package main

import "fmt"

func main() {
    fmt.Println("Hello from Go WASI reactor!")
}
```

## Testing

```bash
# Go harness
cd wazero-go && go test ./...

# JS harness
bun install
bun run test
```

## License

MIT
