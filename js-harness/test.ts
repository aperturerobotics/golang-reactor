// Test script for the JS harness
// Run with: bun test.ts /tmp/gotest/reactor.wasm

import { createReactor, createMinimalWASI } from "./src/index.js";
import { readFileSync } from "fs";

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("Usage: bun test.ts <path-to-reactor.wasm>");
  process.exit(1);
}

console.log("Loading WASM from:", wasmPath);
const wasmBytes = readFileSync(wasmPath);

console.log("Compiling...");
const wasmModule = await WebAssembly.compile(wasmBytes);

console.log("Setting up WASI...");
let output = "";
const wasi = createMinimalWASI({
  args: ["reactor"],
  stdout: (text) => {
    output += text;
    process.stdout.write(text);
  },
  stderr: (text) => process.stderr.write(text),
});

console.log("Creating reactor...");
const reactor = await createReactor(wasmModule, {
  wasiImports: wasi.wasiImports,
  setMemory: (memory) => wasi.setMemory(memory),
  debug: true,
});

console.log("Running reactor...");
await reactor.runAsync();

console.log("\nReactor completed.");
console.log("Output captured:", output.trim());
