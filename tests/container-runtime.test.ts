/**
 * Container runtime — unit tests for the real Docker/Podman configuration
 * builder.
 *
 * The builder does two things:
 * 1. Probes the host for a usable runtime binary (`docker` or `podman`) via
 *    `spawnSync(<binary>, ['--version'])` (no shell string).
 * 2. If one is available, assembles the full `docker run` / `podman run`
 *    argv with the isolation flags prescribed in the plugin PRD:
 *       --network=none --cap-drop=ALL --security-opt=no-new-privileges:true
 *       --read-only -v <agentRoot>:/agent:ro -w /agent
 *    If none is available, it returns an explicit `error` signal rather
 *    than pretending success with `argv: []` and `confined: true`.
 *
 * Tests inject `runtimeProbe` to avoid host-dependency.
 */

import { describe, it, expect } from 'vitest'
import { buildContainerConfig, findAvailableRuntime } from '../lib/container-runtime.js'

describe('container-runtime: findAvailableRuntime', () => {
  it('returns the first candidate that exits 0 on --version', () => {
    // Real probe on this host returns 'docker' (verified separately).
    const found = findAvailableRuntime(['docker', 'podman'])
    expect(found).toBe('docker')
  })

  it('returns null when neither candidate is available', () => {
    const found = findAvailableRuntime(['/nonexistent/a', '/nonexistent/b'])
    expect(found).toBeNull()
  })
})

describe('container-runtime: available runtime produces a real argv', () => {
  it('returns a non-empty argv containing the container flags and python entrypoint', () => {
    const cfg = buildContainerConfig({
      runtime: 'docker',
      agentRoot: '/tmp/test-agent',
      entrypoint: 'agent.py',
      args: ['--task', 'x'],
      readOnlyAgentRoot: true,
      runtimeProbe: () => 'docker',
    })
    expect(cfg.confined).toBe(true)
    expect(cfg.enforcement).toBe('full')
    expect(cfg.argv[0]).toBe('docker')
    expect(cfg.argv).toContain('run')
    expect(cfg.argv).toContain('--network=none')
    expect(cfg.argv).toContain('--cap-drop=ALL')
    expect(cfg.argv).toContain('--security-opt=no-new-privileges:true')
    expect(cfg.argv).toContain('--read-only')
    expect(cfg.argv).toContain('-v')
    expect(cfg.argv).toContain('/tmp/test-agent:/agent:ro')
    expect(cfg.argv).toContain('-w')
    expect(cfg.argv).toContain('/agent')
    expect(cfg.argv).toContain('python3')
    expect(cfg.argv).toContain('/agent/agent.py')
    expect(cfg.argv).toContain('--task')
    expect(cfg.networkDenied).toBe(true)
    expect(cfg.error).toBeUndefined()
  })

  it('falls back to podman when the preferred runtime is unavailable', () => {
    const cfg = buildContainerConfig({
      runtime: 'docker',
      agentRoot: '/tmp/test-agent',
      entrypoint: 'agent.py',
      args: [],
      readOnlyAgentRoot: true,
      runtimeProbe: () => 'podman',
    })
    expect(cfg.argv[0]).toBe('podman')
    expect(cfg.confined).toBe(true)
  })

  it('defaults to the python:3.11-slim image when none is supplied', () => {
    const cfg = buildContainerConfig({
      runtime: 'docker',
      agentRoot: '/tmp/test-agent',
      entrypoint: 'agent.py',
      args: [],
      readOnlyAgentRoot: true,
      runtimeProbe: () => 'docker',
    })
    expect(cfg.argv).toContain('python:3.11-slim')
  })

  it('respects image and extraArgs overrides', () => {
    const cfg = buildContainerConfig({
      runtime: 'docker',
      image: 'custom-pii-agent:latest',
      extraArgs: ['--ipc=none'],
      agentRoot: '/tmp/test-agent',
      entrypoint: 'agent.py',
      args: [],
      readOnlyAgentRoot: true,
      runtimeProbe: () => 'docker',
    })
    expect(cfg.argv).toContain('custom-pii-agent:latest')
    expect(cfg.argv).toContain('--ipc=none')
    // extraArgs sit before the image, so they appear before it in the argv.
    const imageIdx = cfg.argv.indexOf('custom-pii-agent:latest')
    const ipcIdx = cfg.argv.indexOf('--ipc=none')
    expect(ipcIdx).toBeLessThan(imageIdx)
  })
})

describe('container-runtime: unavailable runtime does NOT over-report', () => {
  it('returns an explicit error signal and confined=false', () => {
    const cfg = buildContainerConfig({
      runtime: 'docker',
      agentRoot: '/tmp/test-agent',
      entrypoint: 'agent.py',
      args: [],
      readOnlyAgentRoot: true,
      runtimeProbe: () => null,
    })
    // Worst-case stub bug: argv: [] with confined: true and enforcement:
    // 'full' would lie to a caller into thinking a container-protected
    // run happened. We reject that shape entirely.
    expect(cfg.argv).toEqual([])
    expect(cfg.confined).toBe(false)
    expect(cfg.error).toBeTruthy()
    expect(cfg.error).toMatch(/container runtime unavailable/)
    expect(cfg.error).toMatch(/neither/)
    expect(cfg.enforcement).toBeUndefined()
    expect(cfg.networkDenied).toBe(true)
  })

  it('still reports the expected cwd when the runtime is unavailable', () => {
    const cfg = buildContainerConfig({
      runtime: 'podman',
      agentRoot: '/opt/agent',
      entrypoint: 'a.py',
      args: [],
      readOnlyAgentRoot: true,
      runtimeProbe: () => null,
    })
    expect(cfg.cwd).toBe('/opt/agent')
  })
})
