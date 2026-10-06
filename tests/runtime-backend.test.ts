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
  it('uses sandbox.confine() and records enforcement (marked partial when network layer applies)', () => {
    const r = buildRuntimeConfig({
      ...BASE,
      permissions: { network: false },
      sandbox: {
        confine: (argv, _policy) => ({
          argv: ['bwrap', '--ro-bind', '/', '/', ...argv],
          enforcement: 'full' as const,
          denialSignatures: ['EROFS', 'EACCES'],
          runnerFailureRules: [],
        }),
      },
      backend: 'bubblewrap',
    })
    expect(r.confined).toBe(true)
    // The network layer re-wraps argv, so the provider's own enforcement claim
    // is no longer authoritative for the final shape — we downgrade to partial.
    expect(r.enforcement).toBe('partial')
    expect(r.denialSignatures).toContain('EROFS')
    // When both sandbox AND network-denied: the wrapper layers on top.
    expect(r.argv[0]).toBe('bwrap')
    expect(r.argv).toContain('--unshare-net')
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
