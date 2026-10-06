/**
 * Bridge lifecycle tests: successful execution, exit error, timeout,
 * crash containment, malformed output, and cleanup.
 *
 * These tests use a fake subprocess service that never touches a real
 * Python process — they verify the bridge's lifecycle logic directly.
 */

import { describe, it, expect } from 'vitest'
import { runAgent } from '../lib/bridge.js'
import type { BridgeServices } from '../lib/bridge.js'
import type { AgentRegistryEntry } from '../lib/types.js'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { PassThrough } from 'node:stream'

function makeEntry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    agent_id: 'pii-sanitization',
    name: 'PII Sanitization',
    version: '1.0.0',
    runtime: { type: 'python', version: '3.11' },
    entrypoint: 'agent.py',
    capabilities: ['pii'],
    permissions: { network: true, filesystem: null, shell: false, secrets: [] },
    resources: { timeout_ms: 60000 },
    source: { repository: 'test/repo', path: 'agents/21', commit: 'abc123def456' },
    status: 'experimental',
    root: '/tmp',
    ...overrides,
  }
}

interface FakeHandleOptions {
  exitCode: number | null
  signal: string | null
  stdout?: string
  stderr?: string
  delayMs?: number
}

function makeServices(opts: FakeHandleOptions) {
  const spawned: { spec: SubprocessSpawnSpec }[] = []
  let terminated = false

  const stdout = new PassThrough()
  const stderr = new PassThrough()
  if (opts.stdout) {
    stdout.write(opts.stdout)
    stdout.end()
  } else {
    stdout.end()
  }
  if (opts.stderr) {
    stderr.write(opts.stderr)
    stderr.end()
  } else {
    stderr.end()
  }

  const handle: SubprocessHandle = {
    pid: 4242,
    stdin: undefined,
    stdout,
    stderr,
    collected: {},
    done: (opts.delayMs
      ? new Promise<never>(() => {}) // never settles: timeout path
      : Promise.resolve({
          exitCode: opts.exitCode,
          signal: opts.signal,
        })) as Promise<{ exitCode: number | null; signal: string | null }>,
    terminate: () => {
      terminated = true
    },
  } as unknown as SubprocessHandle

  const services = {
    subprocess: {
      spawn: (spec: SubprocessSpawnSpec) => {
        spawned.push({ spec })
        return handle
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    handle,
    get terminated() {
      return terminated
    },
    get spawnedSpecs() {
      return spawned
    },
  }
  return services
}

const allowAll = {
  allowed: true,
  denied: [] as string[],
  granted: { network: true, filesystem: null, shell: false, secrets: [] },
}

describe('bridge.runAgent', () => {
  it('returns success with parsed JSON on exit 0', async () => {
    const services = makeServices({
      exitCode: 0,
      signal: null,
      stdout: 'INPUT : test\nRESULT : {"status": "success", "sanitized_content": "clean"}\n',
    })

    const result = await runAgent(makeEntry(), { agent_id: 'pii-sanitization', task: 'sanitize' }, services, allowAll)

    expect(result.status).toBe('success')
    if (result.status === 'success') {
      expect(result.result).toMatchObject({ status: 'success', sanitized_content: 'clean' })
      expect(result.metadata.agent_id).toBe('pii-sanitization')
      expect(result.metadata.exit_code).toBe(0)
    }
    // Spawn spec should use python3 + agent root as cwd
    const spec = services.spawnedSpecs[0].spec
    expect(spec.argv[0]).toBe('python3')
    expect(spec.argv[1]).toBe('/tmp/agent.py')
    expect(spec.cwd).toBe('/tmp')
    expect(spec.graceMs).toBe(5000)
  })

  it('returns error on non-zero exit code', async () => {
    const services = makeServices({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'Traceback (most recent call last): ...',
    })

    const result = await runAgent(makeEntry(), { agent_id: 'pii-sanitization', task: 'x' }, services, allowAll)

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error.code).toBe('AGENT_EXIT_ERROR')
      expect(result.error.message).toContain('1')
      expect(result.metadata.exit_code).toBe(1)
    }
  })

  it('classifies signal death with null exit code', async () => {
    const services = makeServices({
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
    })

    const result = await runAgent(makeEntry(), { agent_id: 'pii-sanitization', task: 'x' }, services, allowAll)

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error.code).toBe('AGENT_EXIT_ERROR')
      expect(result.metadata.exit_code).toBeNull()
      expect(result.metadata.signal).toBe('SIGTERM')
    }
  })

  it('terminates the process when the timeout expires (crash/timeout containment)', async () => {
    // done never settles; bridge must still resolve and terminate
    const services = makeServices({
      exitCode: null,
      signal: null,
      delayMs: 30_000, // never resolves
    })

    // Patch the fake done promise to reject after a short delay so the test
    // itself does not hang: bridge catches the rejection as COLLECTION_ERROR
    const timeout = new AbortController()
    const result = await runAgent(
      makeEntry(),
      { agent_id: 'pii-sanitization', task: 'x', timeout_ms: 50 },
      {
        subprocess: services.subprocess,
        logger: services.logger,
      },
      allowAll,
    )

    // The process tree must have been terminated
    expect(services.terminated).toBe(true)
    // Contract section 11: timeout is its own status, not a generic error.
    expect(result.status).toBe('timeout')
    if (result.status === 'timeout') {
      expect(result.error.code).toBe('AGENT_TIMEOUT')
      expect(result.metadata.error).toContain('AGENT_TIMEOUT')
    }
    // The timeout must fire well before the caller's own test deadline,
    // which proves the bridge does not wait for a hung process to settle.
    expect(result.metadata.duration_ms).toBeLessThan(5000)
  }, 10_000)

  it('returns MALFORMED_OUTPUT when stdout has no JSON', async () => {
    const services = makeServices({
      exitCode: 0,
      signal: null,
      stdout: 'plain text without json',
    })

    const result = await runAgent(makeEntry(), { agent_id: 'pii-sanitization', task: 'x' }, services, allowAll)

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error.code).toBe('MALFORMED_OUTPUT')
    }
  })

  it('returns JSON_PARSE_ERROR when stdout JSON is broken', async () => {
    const services = makeServices({
      exitCode: 0,
      signal: null,
      stdout: 'RESULT : {"broken": ,}',
    })

    const result = await runAgent(makeEntry(), { agent_id: 'pii-sanitization', task: 'x' }, services, allowAll)

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error.code).toBe('JSON_PARSE_ERROR')
    }
  })

  it('records full observability metadata on every invocation', async () => {
    const services = makeServices({
      exitCode: 0,
      signal: null,
      stdout: '{"ok": true}',
    })

    const result = await runAgent(
      makeEntry({ version: '2.5.0' }),
      { agent_id: 'pii-sanitization', task: 'x' },
      services,
      allowAll,
    )

    expect(result.metadata.execution_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.metadata.agent_id).toBe('pii-sanitization')
    expect(result.metadata.agent_version).toBe('2.5.0')
    expect(result.metadata.status).toBe('success')
    expect(result.metadata.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('forwards granted secrets into the subprocess env', async () => {
    const services = makeServices({
      exitCode: 0,
      signal: null,
      stdout: '{"ok": true}',
    })

    const granted = {
      network: false,
      filesystem: null,
      shell: false,
      secrets: ['OPENAI_API_KEY'],
    }
    await runAgent(
      makeEntry(),
      { agent_id: 'pii-sanitization', task: 'x', context: { OPENAI_API_KEY: 'sk-test' } },
      services,
      { allowed: true, denied: [], granted },
    )

    const spec = services.spawnedSpecs[0].spec
    expect(spec.env?.OPENAI_API_KEY).toBe('sk-test')
  })

  it('returns VENV_UNAVAILABLE when venv is configured but venv preparation fails', async () => {
    const services = makeServices({
      exitCode: 0,
      signal: null,
      stdout: '{"ok": true}',
    })

    // /tmp does not have a valid venv — ensureVenv() fails.
    const result = await runAgent(
      makeEntry({ venv: '.venv' }),
      { agent_id: 'pii-sanitization', task: 'x' },
      services,
      allowAll,
    )

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error.code).toBe('VENV_UNAVAILABLE')
    }
    // No spawn should have happened because venv preparation failed.
    expect(services.spawnedSpecs).toHaveLength(0)
  }, 15000)

  const networkDeniedGrant = { allowed: true, denied: [] as string[], granted: { network: false, filesystem: null, shell: false, secrets: [] } }

  /** A mock sandbox that reports it produced a bwrap-confined argv. */
  function bwrapSandbox() {
    return {
      confine: (_argv: readonly string[], _policy: unknown) => ({
        argv: ['bwrap', '--ro-bind', '/', '/', '--proc', '/proc', '--', 'python3', '/tmp/agent.py'],
        enforcement: 'full' as const,
        denialSignatures: ['read-only file system'],
        runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }],
      }),
    }
  }

  /** A mock sandbox that reports it produced a Landlock (non-bwrap) argv. */
  function landlockSandbox() {
    return {
      confine: (_argv: readonly string[], _policy: unknown) => ({
        argv: ['/usr/local/bin/landlock-run', '--mode', 'workspace-write', '--', 'python3', '/tmp/agent.py'],
        enforcement: 'full' as const,
        denialSignatures: ['permission denied'],
        runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['/usr/local/bin/landlock-run: '] }],
      }),
    }
  }

  it('DEFECT 1: does not nest bwrap when the sandbox already produced a bwrap argv and network is denied', async () => {
    const services = makeServices({ exitCode: 0, signal: null, stdout: '{"ok": true}' })
    services.sandbox = bwrapSandbox()

    await runAgent(
      makeEntry(),
      { agent_id: 'pii-sanitization', task: 'x' },
      services as unknown as BridgeServices,
      networkDeniedGrant,
    )

    const spec = services.spawnedSpecs[0].spec
    // --unshare-net must be injected INTO the existing bwrap argv, not wrapped
    // around it: `bwrap` must appear exactly once and --unshare-net must sit
    // after it as a bwrap flag.
    expect(spec.argv[0]).toBe('bwrap')
    expect(spec.argv).toContain('--unshare-net')
    expect(spec.argv.indexOf('--unshare-net')).toBeGreaterThan(0)
    expect(spec.argv.filter((a) => a === 'bwrap')).toHaveLength(1)
  })

  it('DEFECT 1 (landlock): does not wrap a non-bwrap sandbox argv in bwrap', async () => {
    const services = makeServices({ exitCode: 0, signal: null, stdout: '{"ok": true}' })
    services.sandbox = landlockSandbox()

    await runAgent(
      makeEntry(),
      { agent_id: 'pii-sanitization', task: 'x' },
      services as unknown as BridgeServices,
      networkDeniedGrant,
    )

    const spec = services.spawnedSpecs[0].spec
    // The launcher must stay argv[0] — no bwrap nesting, no bwrap at all.
    expect(spec.argv[0]).toBe('/usr/local/bin/landlock-run')
    expect(spec.argv.filter((a) => a === 'bwrap')).toHaveLength(0)
  })

  it('DEFECT 2: uses the full bwrap filesystem profile when sandbox is absent and network is denied', async () => {
    const services = makeServices({ exitCode: 0, signal: null, stdout: '{"ok": true}' })
    // No sandbox — services.sandbox stays undefined.

    await runAgent(
      makeEntry({ root: '/agent-root' }),
      { agent_id: 'pii-sanitization', task: 'x' },
      services,
      networkDeniedGrant,
    )

    const spec = services.spawnedSpecs[0].spec
    // The fallback profile must both deny network AND confine the filesystem
    // to the agent root (same shape as runtime-backend's fallback profile).
    expect(spec.argv[0]).toBe('bwrap')
    for (const flag of [
      '--unshare-net',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--bind', '/agent-root', '/agent-root',
      '--die-with-parent',
    ]) {
      expect(spec.argv, `missing bwrap flag ${flag}`).toContain(flag)
    }
    // The real python argv sits after the flags.
    const pyIdx = spec.argv.indexOf('python3')
    expect(pyIdx).toBeGreaterThan(0)
    expect(spec.argv.slice(pyIdx)).toEqual(['python3', '/agent-root/agent.py', '--task', 'x'])
  })

  it('DEFECT 3: does not label the sandbox infrastructure as an agent tool in metadata.tools_used', async () => {
    const services = makeServices({ exitCode: 0, signal: null, stdout: '{"ok": true}' })
    services.sandbox = bwrapSandbox()

    const result = await runAgent(
      makeEntry(),
      { agent_id: 'pii-sanitization', task: 'x' },
      services as unknown as BridgeServices,
      allowAll,
    )

    expect(result.status).toBe('success')
    if (result.status === 'success') {
      // tools_used is the agent's tool telemetry; the sandbox is a runtime
      // concern and must not pollute the agent-tool list.
      expect(result.metadata.tools_used).not.toContain('sandbox')
    }
  })
})
