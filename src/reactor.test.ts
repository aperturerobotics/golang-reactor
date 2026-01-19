import { describe, it, expect } from 'vitest'
import { LoopResult, createMinimalWASI } from './index.js'

describe('LoopResult', () => {
  it('should have correct values', () => {
    expect(LoopResult.Idle).toBe(-1)
    expect(LoopResult.Ready).toBe(0)
  })
})

describe('createMinimalWASI', () => {
  it('should create WASI imports', () => {
    const wasi = createMinimalWASI({})
    expect(wasi.wasiImports).toBeDefined()
    expect(typeof wasi.setMemory).toBe('function')
  })

  it('should have required WASI functions', () => {
    const wasi = createMinimalWASI({})
    const imports = wasi.wasiImports as Record<string, unknown>

    expect(imports.args_get).toBeDefined()
    expect(imports.args_sizes_get).toBeDefined()
    expect(imports.environ_get).toBeDefined()
    expect(imports.environ_sizes_get).toBeDefined()
    expect(imports.clock_time_get).toBeDefined()
    expect(imports.fd_write).toBeDefined()
    expect(imports.fd_close).toBeDefined()
    expect(imports.fd_fdstat_get).toBeDefined()
    expect(imports.fd_fdstat_set_flags).toBeDefined()
    expect(imports.fd_seek).toBeDefined()
    expect(imports.fd_read).toBeDefined()
    expect(imports.fd_prestat_get).toBeDefined()
    expect(imports.fd_prestat_dir_name).toBeDefined()
    expect(imports.proc_exit).toBeDefined()
    expect(imports.random_get).toBeDefined()
    expect(imports.poll_oneoff).toBeDefined()
    expect(imports.sched_yield).toBeDefined()
  })

  it('should use custom args', () => {
    const wasi = createMinimalWASI({
      args: ['program', '--flag', 'value'],
    })
    expect(wasi.wasiImports).toBeDefined()
  })

  it('should use custom env', () => {
    const wasi = createMinimalWASI({
      env: { FOO: 'bar', BAZ: 'qux' },
    })
    expect(wasi.wasiImports).toBeDefined()
  })
})
