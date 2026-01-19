/**
 * JavaScript harness for Go WASI reactor binaries.
 *
 * Go programs built with -buildmode=c-shared for wasip1 export _initialize,
 * go_start_main, and go_tick functions that allow the host to drive execution
 * cooperatively.
 */

/** Result from go_tick indicating scheduler state */
export const enum LoopResult {
  /** No pending work; safe to terminate */
  Idle = -1,
  /** More goroutines are runnable */
  Ready = 0,
  // Values > 0 indicate milliseconds until next timer
}

/** Exports expected from a Go WASI reactor module */
export interface GoReactorExports {
  memory: WebAssembly.Memory;
  _initialize: () => void;
  go_start_main: () => void;
  go_tick: () => number;
}

/** Options for creating a reactor */
export interface ReactorOptions {
  /** WASI imports to provide to the module */
  wasiImports: WebAssembly.ModuleImports;
  /** Called after instantiation with memory, before _initialize */
  setMemory?: (memory: WebAssembly.Memory) => void;
  /** Called before each tick, allowing host to do work */
  onTick?: () => void;
  /** Debug logging */
  debug?: boolean;
}

/** Callback for async loop to allow cooperative waiting */
export type WaitCallback = (ms: number) => Promise<void>;

/**
 * Creates a Go WASI reactor from WebAssembly module and bytes.
 *
 * @param wasmModule - Compiled WebAssembly module
 * @param options - Configuration options including WASI imports
 * @returns Reactor instance
 */
export async function createReactor(
  wasmModule: WebAssembly.Module,
  options: ReactorOptions
): Promise<Reactor> {
  const instance = await WebAssembly.instantiate(wasmModule, {
    wasi_snapshot_preview1: options.wasiImports,
  });

  const exports = instance.exports as unknown as GoReactorExports;

  // Validate exports
  if (typeof exports._initialize !== "function") {
    throw new Error("Module does not export _initialize (not a WASI reactor?)");
  }
  if (typeof exports.go_start_main !== "function") {
    throw new Error(
      "Module does not export go_start_main (not built with modified Go runtime?)"
    );
  }
  if (typeof exports.go_tick !== "function") {
    throw new Error(
      "Module does not export go_tick (not built with modified Go runtime?)"
    );
  }

  // Allow caller to set memory reference before _initialize
  options.setMemory?.(exports.memory);

  // Initialize the module
  exports._initialize();

  return new Reactor(exports, options);
}

/**
 * Reactor wraps a Go WASI reactor module and provides methods to drive it.
 */
export class Reactor {
  private exports: GoReactorExports;
  private mainStarted = false;
  private debug: boolean;
  private onTick?: () => void;

  constructor(exports: GoReactorExports, options: ReactorOptions) {
    this.exports = exports;
    this.debug = options.debug ?? false;
    this.onTick = options.onTick;
  }

  private log(...args: unknown[]) {
    if (this.debug) {
      console.log("[GoReactor]", ...args);
    }
  }

  /**
   * Starts the main goroutine.
   * Must be called before loopOnce or run.
   */
  startMain(): void {
    if (this.mainStarted) {
      return;
    }
    this.log("startMain");
    this.exports.go_start_main();
    this.mainStarted = true;
  }

  /**
   * Runs one iteration of the Go scheduler.
   * @returns Result indicating when to call again
   */
  loopOnce(): LoopResult {
    const result = this.exports.go_tick();
    this.log("go_tick ->", result);
    return result as LoopResult;
  }

  /**
   * Runs the reactor synchronously until idle.
   * Note: This will block if timers are used!
   * Use runAsync for programs with timers.
   */
  runSync(): void {
    this.startMain();

    while (true) {
      this.onTick?.();

      const result = this.loopOnce();

      if (result === LoopResult.Idle) {
        return;
      }

      if (result > 0) {
        // Timer pending - in sync mode, we can't wait properly
        // This will spin-wait which is not ideal
        const start = Date.now();
        while (Date.now() - start < result) {
          // Busy wait - not recommended for real use
        }
      }
    }
  }

  /**
   * Runs the reactor asynchronously until idle.
   * Uses await for timer delays.
   *
   * @param wait - Function to wait for a given number of milliseconds
   */
  async runAsync(
    wait: WaitCallback = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ): Promise<void> {
    this.startMain();

    while (true) {
      this.onTick?.();

      const result = this.loopOnce();

      if (result === LoopResult.Idle) {
        return;
      }

      if (result === LoopResult.Ready) {
        // More work available, yield to event loop then continue
        await Promise.resolve();
        continue;
      }

      if (result > 0) {
        // Wait for timer
        await wait(result);
      }
    }
  }

  /**
   * Gets the WebAssembly memory for advanced usage.
   */
  get memory(): WebAssembly.Memory {
    return this.exports.memory;
  }
}

/**
 * Minimal WASI implementation for Go reactors.
 * This provides just enough WASI to run basic Go programs.
 * For full WASI support, use a proper WASI implementation like @aspect/browser-wasi-shim.
 */
export function createMinimalWASI(options: {
  args?: string[];
  env?: Record<string, string>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}): {
  wasiImports: WebAssembly.ModuleImports;
  setMemory: (memory: WebAssembly.Memory) => void;
} {
  let memory: WebAssembly.Memory | null = null;

  const args = options.args ?? ["reactor"];
  const env = options.env ?? {};
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;

  const envArray = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const wasiImports: WebAssembly.ModuleImports = {
    args_sizes_get: (argc_ptr: number, argv_buf_size_ptr: number): number => {
      const view = new DataView(memory!.buffer);
      view.setUint32(argc_ptr, args.length, true);
      let bufSize = 0;
      for (const arg of args) {
        bufSize += encoder.encode(arg).length + 1;
      }
      view.setUint32(argv_buf_size_ptr, bufSize, true);
      return 0;
    },

    args_get: (argv_ptr: number, argv_buf_ptr: number): number => {
      const view = new DataView(memory!.buffer);
      const mem = new Uint8Array(memory!.buffer);
      let bufOffset = argv_buf_ptr;
      for (let i = 0; i < args.length; i++) {
        view.setUint32(argv_ptr + i * 4, bufOffset, true);
        const encoded = encoder.encode(args[i]);
        mem.set(encoded, bufOffset);
        mem[bufOffset + encoded.length] = 0;
        bufOffset += encoded.length + 1;
      }
      return 0;
    },

    environ_sizes_get: (
      environ_count_ptr: number,
      environ_buf_size_ptr: number
    ): number => {
      const view = new DataView(memory!.buffer);
      view.setUint32(environ_count_ptr, envArray.length, true);
      let bufSize = 0;
      for (const e of envArray) {
        bufSize += encoder.encode(e).length + 1;
      }
      view.setUint32(environ_buf_size_ptr, bufSize, true);
      return 0;
    },

    environ_get: (
      environ_ptr: number,
      environ_buf_ptr: number
    ): number => {
      const view = new DataView(memory!.buffer);
      const mem = new Uint8Array(memory!.buffer);
      let bufOffset = environ_buf_ptr;
      for (let i = 0; i < envArray.length; i++) {
        view.setUint32(environ_ptr + i * 4, bufOffset, true);
        const encoded = encoder.encode(envArray[i]);
        mem.set(encoded, bufOffset);
        mem[bufOffset + encoded.length] = 0;
        bufOffset += encoded.length + 1;
      }
      return 0;
    },

    clock_time_get: (
      clock_id: number,
      _precision: bigint,
      time_ptr: number
    ): number => {
      const view = new DataView(memory!.buffer);
      let time: bigint;
      if (clock_id === 0) {
        // CLOCK_REALTIME
        time = BigInt(Date.now()) * 1_000_000n;
      } else {
        // CLOCK_MONOTONIC
        time = BigInt(Math.round(performance.now() * 1_000_000));
      }
      view.setBigUint64(time_ptr, time, true);
      return 0;
    },

    fd_write: (
      fd: number,
      iovs_ptr: number,
      iovs_len: number,
      nwritten_ptr: number
    ): number => {
      const view = new DataView(memory!.buffer);
      const mem = new Uint8Array(memory!.buffer);
      let written = 0;
      let text = "";

      for (let i = 0; i < iovs_len; i++) {
        const ptr = view.getUint32(iovs_ptr + i * 8, true);
        const len = view.getUint32(iovs_ptr + i * 8 + 4, true);
        text += decoder.decode(mem.slice(ptr, ptr + len));
        written += len;
      }

      if (fd === 1) {
        stdout(text);
      } else if (fd === 2) {
        stderr(text);
      }

      view.setUint32(nwritten_ptr, written, true);
      return 0;
    },

    fd_close: (_fd: number): number => 0,
    fd_fdstat_get: (fd: number, stat_ptr: number): number => {
      // Return basic file descriptor stats
      const view = new DataView(memory!.buffer);
      // fs_filetype (u8): 0=unknown, 1=block, 2=character, 4=directory, 6=regular
      if (fd <= 2) {
        view.setUint8(stat_ptr, 2); // character device for stdin/stdout/stderr
      } else {
        view.setUint8(stat_ptr, 6); // regular file
      }
      // fs_flags (u16) at offset 2
      view.setUint16(stat_ptr + 2, 0, true);
      // fs_rights_base (u64) at offset 8
      view.setBigUint64(stat_ptr + 8, 0xFFFFFFFFFFFFFFFFn, true);
      // fs_rights_inheriting (u64) at offset 16
      view.setBigUint64(stat_ptr + 16, 0xFFFFFFFFFFFFFFFFn, true);
      return 0;
    },
    fd_fdstat_set_flags: (_fd: number, _flags: number): number => 0,
    fd_seek: (
      _fd: number,
      _offset: bigint,
      _whence: number,
      _newoffset_ptr: number
    ): number => 0,
    fd_read: (
      _fd: number,
      _iovs_ptr: number,
      _iovs_len: number,
      _nread_ptr: number
    ): number => 0,
    fd_prestat_get: (_fd: number, _prestat_ptr: number): number => 8, // EBADF
    fd_prestat_dir_name: (
      _fd: number,
      _path_ptr: number,
      _path_len: number
    ): number => 8,

    proc_exit: (code: number): void => {
      throw new Error(`exit(${code})`);
    },

    random_get: (buf_ptr: number, buf_len: number): number => {
      const mem = new Uint8Array(memory!.buffer);
      crypto.getRandomValues(mem.slice(buf_ptr, buf_ptr + buf_len));
      return 0;
    },

    poll_oneoff: (
      _in_ptr: number,
      _out_ptr: number,
      _nsubscriptions: number,
      _nevents_ptr: number
    ): number => {
      // Minimal implementation - just return immediately
      return 0;
    },

    sched_yield: (): number => 0,
  };

  return {
    wasiImports,
    setMemory: (mem: WebAssembly.Memory) => {
      memory = mem;
    },
  };
}
