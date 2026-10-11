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

  /**
   * A mock sandbox that reports it produced a bwrap-confined argv.
   *
   * `confine` returns a Promise because the real `SandboxProvider.confine` is
   * async: a synchronous mock let the bridge skip its `await` and still read
   * `denialSignatures` off the returned object, which is how the missing-await
   * defect shipped.
   */
  function bwrapSandbox() {
    return {
      confine: async (_argv: readonly string[], _policy: unknown) => ({
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
      confine: async (_argv: readonly string[], _policy: unknown) => ({
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
      '--die-with-parent',
    ]) {
      expect(spec.argv, `missing bwrap flag ${flag}`).toContain(flag)
    }
    // The real python argv sits after the flags.
    const pyIdx = spec.argv.indexOf('python3')
    expect(pyIdx).toBeGreaterThan(0)
    expect(spec.argv.slice(pyIdx)).toEqual(['python3', '/agent-root/agent.py', '--task', 'x'])
  })

  it('filesystem default-deny: a null grant binds the agent root READ-ONLY', async () => {
    const services = makeServices({ exitCode: 0, signal: null, stdout: '{"ok": true}' })

    await runAgent(
      makeEntry({ root: '/agent-root' }),
      { agent_id: 'pii-sanitization', task: 'x' },
      services,
      // granted.filesystem: null — the default-deny grant every current
      // registry entry carries.
      networkDeniedGrant,
    )

    const spec = services.spawnedSpecs[0].spec
    // The root itself must not be writable: --ro-bind root root, never --bind.
    const rootBindIdx = spec.argv.indexOf('/agent-root', spec.argv.indexOf('--tmpfs') + 2)
    const bindFlag = spec.argv[rootBindIdx - 1]
    expect(bindFlag).toBe('--ro-bind')
    expect(spec.argv).not.toContain('--bind')
  })

  it('filesystem opt-in: a readwrite grant binds the agent root READ-WRITE', async () => {
    const services = makeServices({ exitCode: 0, signal: null, stdout: '{"ok": true}' })

    await runAgent(
      makeEntry({ root: '/agent-root' }),
      { agent_id: 'pii-sanitization', task: 'x' },
      services,
      {
        allowed: true,
        denied: [],
        granted: {
          network: false,
          filesystem: { mode: 'readwrite', paths: ['.'] },
          shell: false,
          secrets: [],
        },
      },
    )

    const spec = services.spawnedSpecs[0].spec
    // An explicit readwrite grant is the ONLY way the root becomes writable.
    expect(spec.argv).toContain('--bind')
    const bindIdx = spec.argv.indexOf('--bind')
    expect(spec.argv.slice(bindIdx, bindIdx + 3)).toEqual(['--bind', '/agent-root', '/agent-root'])
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

  // ── Sandbox policy mirrors the evaluated filesystem grant ──────────────────
  //
  // The DSH sandbox vocabulary covers file effects only, so the bridge's
  // job is to translate `granted.filesystem` into the right mode: the
  // default-deny grants (null / 'read' / 'none') become 'read-only' and only
  // an explicit 'readwrite' grant becomes 'workspace-write'. Before this
  // mapping, every agent was confined as workspace-write — full write to its
  // root — regardless of what the registry declared.

  function policyCapturingSandbox() {
    const seen: Array<{ mode: string; workspaceRoot: string }> = []
    return {
      seen,
      sandbox: {
        confine: async (_argv: readonly string[], policy: { mode: string; workspaceRoot: string }) => {
          seen.push(policy)
          return {
            argv: ['bwrap', '--ro-bind', '/', '/', '--', 'python3', '/tmp/agent.py'],
            enforcement: 'full' as const,
            denialSignatures: [],
            runnerFailureRules: [],
          }
        },
      },
    }
  }

  it('sandbox policy: default-deny filesystem grant → read-only mode', async () => {
    const services = makeServices({ exitCode: 0, signal: null, stdout: '{"ok": true}' })
    const capture = policyCapturingSandbox()
    services.sandbox = capture.sandbox

    await runAgent(
      makeEntry(),
      { agent_id: 'pii-sanitization', task: 'x' },
      services as unknown as BridgeServices,
      networkDeniedGrant,
    )

    expect(capture.seen).toHaveLength(1)
    expect(capture.seen[0].mode).toBe('read-only')
    expect(capture.seen[0].workspaceRoot).toBe('/tmp')
  })

  it('sandbox policy: readwrite grant → workspace-write mode', async () => {
    const services = makeServices({ exitCode: 0, signal: null, stdout: '{"ok": true}' })
    const capture = policyCapturingSandbox()
    services.sandbox = capture.sandbox

    await runAgent(
      makeEntry(),
      { agent_id: 'pii-sanitization', task: 'x' },
      services as unknown as BridgeServices,
      {
        allowed: true,
        denied: [],
        granted: {
          network: true,
          filesystem: { mode: 'readwrite', paths: ['.'] },
          shell: false,
          secrets: [],
        },
      },
    )

    expect(capture.seen[0].mode).toBe('workspace-write')
  })
})

/**
 * DEFECT 4: collect-mode output was read from the wrong place.
 *
 * The spawn spec requests `stdout: { maxBytes, spill }`, which is the
 * subprocess service's COLLECT disposition. In collect mode the service
 * withholds the raw pipe — `subprocess-local/src/spawn.ts` only exposes
 * `child.stdout` when the mode is literally `'pipe'` — so `handle.stdout` is
 * `undefined` and the payload lives on `handle.collected.stdout` as an
 * offset-based reader. The bridge used to read `handle.stdout`, so every
 * agent invocation collected the empty string and was classified
 * MALFORMED_OUTPUT even though the agent exited 0 having printed valid JSON.
 *
 * The handle built below is the real collect-mode shape: no raw pipes, a
 * `collected` reader that is batch-shaped like the real one — it answers
 * EMPTY until the process settles and only then returns the full text. That
 * second half matters: a reader which answers immediately would let a bridge
 * that reads BEFORE settlement pass, and that premature read is the other way
 * this defect resurfaces (an agent that printed valid JSON still reported as
 * malformed). A test wired only with PassThrough pipes cannot catch either
 * half — it exercises the pipe path that production never takes.
 */
function makeCollectModeServices(opts: FakeHandleOptions) {
  const spawned: { spec: SubprocessSpawnSpec }[] = []
  let settled = false

  const reader = (text: string) => ({
    readFrom: (fromByte: number) => ({
      text: settled ? text : '',
      nextOffset: fromByte + (settled ? text.length : 0),
      lossy: false,
    }),
  })

  const handle: SubprocessHandle = {
    pid: 4343,
    stdin: undefined,
    // Collect mode: the service exposes NO raw pipe.
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: reader(opts.stdout ?? ''),
      stderr: reader(opts.stderr ?? ''),
    },
    done: (opts.delayMs
      ? new Promise<never>(() => {}) // never settles: timeout path
      : Promise.resolve({
          exitCode: opts.exitCode,
          signal: opts.signal,
        }).then((o) => {
          // The reader only has its payload once the process has closed.
          settled = true
          return o
        })) as Promise<{ exitCode: number | null; signal: string | null }>,
    terminate: () => {},
  } as unknown as SubprocessHandle

  return {
    subprocess: {
      spawn: (spec: SubprocessSpawnSpec) => {
        spawned.push({ spec })
        return handle
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    handle,
    get spawnedSpecs() {
      return spawned
    },
  }
}

describe('bridge.runAgent — collect-mode output disposition', () => {
  it('DEFECT 4: parses agent stdout from handle.collected when raw pipes are withheld', async () => {
    const services = makeCollectModeServices({
      exitCode: 0,
      signal: null,
      stdout: '{"status":"success","result":"clean"}',
    })

    const result = await runAgent(
      makeEntry(),
      { agent_id: 'pii-sanitization', task: 'x' },
      services as unknown as BridgeServices,
      allowAll,
    )

    expect(result.status).toBe('success')
    if (result.status === 'success') {
      expect(result.result).toMatchObject({ status: 'success', result: 'clean' })
    }
  })

  it('DEFECT 4: surfaces collected stderr on a non-zero exit', async () => {
    const services = makeCollectModeServices({
      exitCode: 1,
      signal: null,
      stderr: 'Traceback (most recent call last): ...',
    })

    const result = await runAgent(
      makeEntry(),
      { agent_id: 'pii-sanitization', task: 'x' },
      services as unknown as BridgeServices,
      allowAll,
    )

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error.code).toBe('AGENT_EXIT_ERROR')
      const details = result.error.details as { stderr: string }
      expect(details.stderr).toContain('Traceback')
    }
  })

  it('DEFECT 4: still reports MALFORMED_OUTPUT when collected stdout carries no JSON', async () => {
    const services = makeCollectModeServices({
      exitCode: 0,
      signal: null,
      stdout: 'plain progress text without json',
    })

    const result = await runAgent(
      makeEntry(),
      { agent_id: 'pii-sanitization', task: 'x' },
      services as unknown as BridgeServices,
      allowAll,
    )

    // The gate must stay sharp: reading from the right place must not turn
    // every non-JSON payload into a success.
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error.code).toBe('MALFORMED_OUTPUT')
    }
  })
})
