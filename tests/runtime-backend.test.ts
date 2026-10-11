/**
 * RuntimeBackend tests — proves network denial is actually enforced
 * at the argv level, not just an env-var claim.
 *
 * Covers:
 *   - bubblewrap backend with network denied → bwrap --unshare-net present
 *   - bubblewrap backend with network granted → no unshare-net wrapper
 *   - local backend → no sandbox wrapper (direct python argv); networkDenied
 *     reports what was *actually* denied by this backend (always false,
 *     since local applies no isolation)
 *   - container backend → delegates to buildContainerConfig and carries
 *     its `error` signal when no runtime binary is available
 *   - sandbox confine() integration → argv wrapped + enforcement recorded
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildRuntimeConfig } from '../lib/runtime-backend.js'
import { join } from 'node:path'

const BASE = {
  pythonBin: '/usr/bin/python3',
  agentRoot: '/tmp/test-agent',
  entrypoint: 'agent.py',
  args: ['--task', 'x'],
}

describe('runtime-backend: bubblewrap backend', () => {
  it('adds --unshare-net when network is denied', () => {
    const r = buildRuntimeConfig({
      ...BASE,
      permissions: { network: false },
      sandbox: undefined,
      backend: 'bubblewrap',
    })
    expect(r.argv[0]).toBe('bwrap')
    expect(r.argv).toContain('--unshare-net')
    expect(r.networkDenied).toBe(true)
    expect(r.confined).toBe(false)
  })

  it('does NOT add --unshare-net when network is granted', () => {
    const r = buildRuntimeConfig({
      ...BASE,
      permissions: { network: true },
      sandbox: undefined,
      backend: 'bubblewrap',
    })
    expect(r.argv[0]).toBe('/usr/bin/python3')
    expect(r.argv).not.toContain('--unshare-net')
    expect(r.networkDenied).toBe(false)
  })

  it('preserves the full argv chain through bwrap wrapper', () => {
    const r = buildRuntimeConfig({
      ...BASE,
      permissions: { network: false },
      sandbox: undefined,
      backend: 'bubblewrap',
    })
    // The python binary and args must survive the wrapper
    expect(r.argv).toContain('/usr/bin/python3')
    expect(r.argv).toContain('--task')
    expect(r.argv).toContain('/tmp/test-agent/agent.py')
  })
})

describe('runtime-backend: local backend', () => {
  it('returns raw argv without any sandbox wrapper', () => {
    const r = buildRuntimeConfig({
      ...BASE,
      permissions: { network: false },
      sandbox: undefined,
      backend: 'local',
    })
    expect(r.argv[0]).toBe('/usr/bin/python3')
    expect(r.argv).not.toContain('bwrap')
    expect(r.argv).not.toContain('--unshare-net')
    expect(r.confined).toBe(false)
    // must report false — the honest value — rather than the old no-op ternary
    // `noNetwork ? false : false` which could hide a future edit to one arm.
    expect(r.networkDenied).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Hygiene gate: the no-op ternary that produced DEFECT 1 is no longer in the
  // emitted source. Reading the compiled lib is intentional: it catches a
  // regression even when src/ is edited and the test file is not re-compiled
  // first. The assertion is a lint-level check; it does not prove logic but
  // it does prove we did not ship a double-false ternary that looks like a
  // placeholder.
  it('emitted source does not contain the no-op ternary noNetwork ? false : false', () => {
    const compiled = readFileSync(
      join(import.meta.dirname, '..', 'lib', 'runtime-backend.js'),
      'utf8',
    )
    expect(compiled).not.toContain('noNetwork ? false : false')
    // The plain literal that replaces it must be present.
    expect(compiled).toContain('networkDenied: false,')
  })
})

describe('runtime-backend: sandbox confine integration', () => {
  it('injects --unshare-net INTO an existing bwrap profile instead of nesting it', () => {
    const r = buildRuntimeConfig({
      ...BASE,
      permissions: { network: false },
      sandbox: {
        confine: (argv, _policy) => ({
          // No '--' separator in this mock — the boundary must still be
          // computed from the first non-flag argument, never from the
          // command tail.
          argv: ['bwrap', '--ro-bind', '/', '/', ...argv],
          enforcement: 'full' as const,
          denialSignatures: ['EROFS', 'EACCES'],
          runnerFailureRules: [],
        }),
      },
      backend: 'bubblewrap',
    })
    expect(r.confined).toBe(true)
    // The injected profile keeps everything the sandbox granted, so its
    // 'full' claim still stands — the old re-wrap downgraded to 'partial'
    // because it lost the profile; injecting into it loses nothing.
    expect(r.enforcement).toBe('full')
    expect(r.denialSignatures).toContain('EROFS')
    // Nested-wrapper killer: `bwrap` and `--unshare-net` each appear exactly
    // once, and the payload survives the flags in its original order.
    expect(r.argv.filter((a) => a === 'bwrap')).toHaveLength(1)
    expect(r.argv.filter((a) => a === '--unshare-net')).toHaveLength(1)
    const pyIdx = r.argv.indexOf('/usr/bin/python3')
    expect(pyIdx).toBeGreaterThan(1)
    expect(r.argv.slice(pyIdx)).toEqual(['/usr/bin/python3', '/tmp/test-agent/agent.py', '--task', 'x'])
  })

  it('leaves an argv that already denies network untouched', () => {
    const r = buildRuntimeConfig({
      ...BASE,
      permissions: { network: false },
      sandbox: {
        confine: (argv, policy) => {
          expect(policy.mode).toBe('read-only')
          return {
            argv: ['bwrap', '--unshare-net', '--ro-bind', '/', '/', '--', ...argv],
            enforcement: 'full' as const,
            denialSignatures: ['EROFS'],
            runnerFailureRules: [],
          }
        },
      },
      backend: 'bubblewrap',
    })
    expect(r.argv.filter((a) => a === '--unshare-net')).toHaveLength(1)
    expect(r.argv.indexOf('--unshare-net')).toBe(1)
    expect(r.enforcement).toBe('full')
  })

  it('maps the filesystem grant into the sandbox policy mode', () => {
    const seen: string[] = []
    const probe = (argv: readonly string[]) => ({
      argv: ['bwrap', '--ro-bind', '/', '/', '--', ...argv],
      enforcement: 'full' as const,
      denialSignatures: [] as readonly string[],
      runnerFailureRules: [] as const,
    })
    buildRuntimeConfig({
      ...BASE,
      permissions: { network: false },
      sandbox: { confine: (argv, policy) => { seen.push(policy.mode); return probe(argv) } },
      backend: 'bubblewrap',
    })
    buildRuntimeConfig({
      ...BASE,
      permissions: { network: false, filesystemWritable: true },
      sandbox: { confine: (argv, policy) => { seen.push(policy.mode); return probe(argv) } },
      backend: 'bubblewrap',
    })
    expect(seen).toEqual(['read-only', 'workspace-write'])
  })

  it('reports a runner gap when the sandbox returns a non-bwrap runner', () => {
    const r = buildRuntimeConfig({
      ...BASE,
      permissions: { network: false },
      sandbox: {
        confine: (argv, _policy) => ({
          argv: ['/usr/local/bin/landlock-run', '--mode', 'read-only', '--', ...argv],
          enforcement: 'full' as const,
          denialSignatures: ['permission denied'],
          runnerFailureRules: [],
        }),
      },
      backend: 'bubblewrap',
    })
    expect(r.confined).toBe(true)
    // The gap is reported, not papered over: no bwrap is injected around a
    // runner whose flag dialect is not bwrap's.
    expect(r.enforcement).toBe('partial')
    expect(r.argv).not.toContain('--unshare-net')
    expect(r.argv.filter((a) => a === 'bwrap')).toHaveLength(0)
    expect(r.argv[0]).toBe('/usr/local/bin/landlock-run')
  })

  it('uses sandbox.confine() without network wrapper when granted', () => {
    const r = buildRuntimeConfig({
      ...BASE,
      permissions: { network: true },
      sandbox: {
        confine: (argv, _policy) => ({
          argv: ['bwrap', '--ro-bind', '/', '/', ...argv],
          enforcement: 'full' as const,
          denialSignatures: ['EROFS'],
          runnerFailureRules: [],
        }),
      },
      backend: 'bubblewrap',
    })
    expect(r.confined).toBe(true)
    expect(r.argv).not.toContain('--unshare-net')
    expect(r.enforcement).toBe('full')
  })

  it('binds the agent root read-only in the fallback profile unless readwrite is granted', () => {
    const readOnly = buildRuntimeConfig({
      ...BASE,
      permissions: { network: false },
      sandbox: undefined,
      backend: 'bubblewrap',
    })
    expect(readOnly.argv).toContain('--ro-bind')
    expect(readOnly.argv).not.toContain('--bind')

    const writable = buildRuntimeConfig({
      ...BASE,
      permissions: { network: false, filesystemWritable: true },
      sandbox: undefined,
      backend: 'bubblewrap',
    })
    const bindIdx = writable.argv.indexOf('--bind')
    expect(bindIdx).toBeGreaterThan(-1)
    expect(writable.argv.slice(bindIdx, bindIdx + 3)).toEqual(['--bind', '/tmp/test-agent', '/tmp/test-agent'])
  })
})

describe('runtime-backend: container backend', () => {
  it('delegates to buildContainerConfig and carries its result through', () => {
    const r = buildRuntimeConfig({
      ...BASE,
      permissions: { network: false },
      sandbox: undefined,
      backend: 'container',
      // Stub the runtime probe so the test is host-independent.
      containerRuntimeProbe: () => 'docker',
    })
    expect(r.confined).toBe(true)
    expect(r.enforcement).toBe('full')
    expect(r.argv[0]).toBe('docker')
    expect(r.argv).toContain('run')
    expect(r.argv).toContain('--network=none')
    expect(r.argv).toContain('--cap-drop=ALL')
    expect(r.argv).toContain('--security-opt=no-new-privileges:true')
    expect(r.argv).toContain('--read-only')
    expect(r.argv).toContain('/tmp/test-agent:/agent:ro')
    expect(r.argv).toContain('/agent/agent.py')
    expect(r.argv).toContain('python3')
    expect(r.argv).toContain('--task')
    expect(r.networkDenied).toBe(true)
    expect(r.error).toBeUndefined()
  })

  it('returns an explicit error signal when no container runtime is available', () => {
    const r = buildRuntimeConfig({
      ...BASE,
      permissions: { network: false },
      sandbox: undefined,
      backend: 'container',
      // Force the unavailable-runs signal. The old stub returned
      // argv: baseArgv, confined: false with no warning — operators
      // configured for "container" would get an unconfined run and
      // no indication of it.
      containerRuntimeProbe: () => null,
    })
    // Must NOT over-report: confined stays false and error is surfaced.
    expect(r.argv).toEqual([])
    expect(r.confined).toBe(false)
    expect(r.error).toMatch(/container runtime unavailable/)
    expect(r.error).toMatch(/neither/)
    expect(r.enforcement).toBeUndefined()
  })
})
