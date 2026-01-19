// Example demonstrates running a Go WASI reactor.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/tetratelabs/wazero"
	reactor "github.com/user/golang-reactor/wazero-go"
)

func main() {
	wasmPath := flag.String("wasm", "", "path to Go WASI reactor .wasm file")
	flag.Parse()

	if *wasmPath == "" {
		log.Fatal("usage: example -wasm <path-to-reactor.wasm>")
	}

	wasm, err := os.ReadFile(*wasmPath)
	if err != nil {
		log.Fatalf("read wasm: %v", err)
	}

	ctx := context.Background()

	r := wazero.NewRuntime(ctx)
	defer r.Close(ctx)

	fmt.Println("Creating reactor...")
	react, err := reactor.NewReactor(ctx, r, wasm, nil)
	if err != nil {
		log.Fatalf("create reactor: %v", err)
	}
	defer react.Close(ctx)

	fmt.Println("Running reactor...")
	if err := react.Run(ctx); err != nil {
		log.Fatalf("run reactor: %v", err)
	}

	fmt.Println("Reactor completed.")
}
