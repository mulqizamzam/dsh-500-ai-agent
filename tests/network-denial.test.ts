/**
 * Unit tests for the shared network-denial argv surgery.
 *
 * This module is the single implementation behind "network: false actually
 * means something". The bridge and the RuntimeBackend abstraction both call
 * it; DEFECT 1 survived in runtime-backend.ts precisely because the logic was
 * duplicated and only one copy was fixed.
 */

import { describe, it, expect } from 'vitest'
import { applyNetworkDenial } from '../lib/network-denial.js'

const PAYLOAD = ['python3', '/agent/agent.py', '--task', 'hello']

describe('network-denial: bwrap runner already in front', () => {
  it('injects --unshare-net into the existing profile (single bwrap, payload intact)', () => {
    const argv = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--', ...PAYLOAD]
    const r = applyNetworkDenial({ argv, sandboxUsed: true, agentRoot: '/agent', rootWritable: false })

    expect(r.action).toBe('injected')
    expect(r.enforcement).toBeUndefined()
    expect(r.argv[0]).toBe('bwrap')
    expect(r.argv[1]).toBe('--unshare-net')
    // Exactly one bwrap: a second one would be exec'd as the payload command
    // with no profile at all.
    expect(r.argv.filter((a) => a === 'bwrap')).toHaveLength(1)
    // The payload survives the flags in its original order.
    const pyIdx = r.argv.indexOf('python3')
    expect(r.argv.slice(pyIdx)).toEqual(PAYLOAD)
    // Original profile flags are preserved.
    expect(r.argv).toContain('--ro-bind')
    expect(r.argv).toContain('--dev')
  })

  it('leaves an argv that already carries --unshare-net untouched', () => {
    const argv = ['bwrap', '--unshare-net', '--ro-bind', '/', '/', '--', ...PAYLOAD]
    const r = applyNetworkDenial({ argv, sandboxUsed: true, agentRoot: '/agent', rootWritable: false })

    expect(r.action).toBe('already-present')
    expect(r.argv).toBe(argv)
  })

  // Falsification-killer: the old boundary scan treated every element before
  // a (possibly absent) `--` separator as profile flags. With no separator
  // that sweep reached into the COMMAND, so a task whose text is literally
  // `--unshare-net` made the bridge believe the profile already denied the
  // network and skip the injection entirely.
  it('does not let a COMMAND argument named like a flag suppress the injection', () => {
    const argv = ['bwrap', '--ro-bind', '/', '/', 'python3', '/agent/agent.py', '--task', '--unshare-net']
    const r = applyNetworkDenial({ argv, sandboxUsed: true, agentRoot: '/agent', rootWritable: false })

    // The injection must HAPPEN: the old scan found the command's own
    // '--unshare-net' text and concluded the profile already had it.
    expect(r.action).toBe('injected')
    // The flag the helper added sits at index 1, ahead of the profile.
    expect(r.argv[1]).toBe('--unshare-net')
    // The command tail — including its own '--unshare-net' argument — is
    // passed through untouched.
    expect(r.argv.slice(r.argv.indexOf('python3'))).toEqual([
      'python3', '/agent/agent.py', '--task', '--unshare-net',
    ])
  })
})

describe('network-denial: non-bwrap runner in front', () => {
  it('reports the gap instead of wrapping a runner it cannot nest', () => {
    const argv = ['/usr/local/bin/landlock-run', '--mode', 'read-only', '--', ...PAYLOAD]
    const r = applyNetworkDenial({ argv, sandboxUsed: true, agentRoot: '/agent', rootWritable: false })

    expect(r.action).toBe('runner-gap')
    expect(r.enforcement).toBe('partial')
    // No bwrap anywhere, no network flag invented for a foreign dialect.
    expect(r.argv).toBe(argv)
    expect(r.argv.filter((a) => a === 'bwrap')).toHaveLength(0)
    expect(r.argv).not.toContain('--unshare-net')
  })
})

describe('network-denial: no sandbox provider at all', () => {
  it('builds the full fallback profile with the agent root READ-ONLY by default', () => {
    const r = applyNetworkDenial({ argv: PAYLOAD, sandboxUsed: false, agentRoot: '/agent', rootWritable: false })

    expect(r.action).toBe('fallback-profile')
    expect(r.argv[0]).toBe('bwrap')
    expect(r.argv[1]).toBe('--unshare-net')
    for (const flag of ['--ro-bind', '--dev', '--tmpfs', '--die-with-parent']) {
      expect(r.argv).toContain(flag)
    }
    // Host read-only AND agent root read-only.
    expect(r.argv).not.toContain('--bind')
    const rootIdx = r.argv.indexOf('--ro-bind', r.argv.indexOf('--tmpfs'))
    expect(r.argv.slice(rootIdx, rootIdx + 3)).toEqual(['--ro-bind', '/agent', '/agent'])
    expect(r.argv.slice(r.argv.indexOf('python3'))).toEqual(PAYLOAD)
  })

  it('binds the agent root READ-WRITE only on an explicit readwrite grant', () => {
    const r = applyNetworkDenial({ argv: PAYLOAD, sandboxUsed: false, agentRoot: '/agent', rootWritable: true })

    expect(r.action).toBe('fallback-profile')
    const bindIdx = r.argv.indexOf('--bind')
    expect(bindIdx).toBeGreaterThan(-1)
    expect(r.argv.slice(bindIdx, bindIdx + 3)).toEqual(['--bind', '/agent', '/agent'])
  })
})
