/**
 * End-to-end test: run the actual PII sanitization Python agent through the
 * real bridge (subprocess spawn, timeout, output validation), not a fake.
 *
 * Two scenarios:
 * 1. Fail-closed: TRUSTBOOST_API_BASE points to an unreachable address
 *    (127.0.0.1:1 → connection refused) → the agent must print its
 *    fail-closed JSON and exit 0. Proves: process isolation, stdout
 *    capture, JSON validation, metadata.
 * 2. Success: a local HTTP fixture stands in for the TrustBoost API → the
 *    agent must exit 0 and the bridge must parse the structured result.
 *    Proves: env forwarding (TRUSTBOOST_API_BASE override) + happy path.
 *
 * Marked with the `.e2e` config so `vitest run` (unit gate) does not
 * require the Python agent checkout to be present.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { BRIDGE_E2E_TIMEOUT_MS, VITEST_E2E_BUDGET_MS } from './e2e-constants.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Resolve the real agent root without assuming a fixed layout. */
function agentRoot(): string | null {
  const candidates = [
    join(here, '../../../500-AI-Agents-Projects/agents/21-pii-sanitization-agent'),
    join(here, '../../../../500-AI-Agents-Projects/agents/21-pii-sanitization-agent'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'agent.py'))) return c
  }
  return null
}

/** Minimum spawn service the bridge needs: a real child process. */
function makeRealSubprocess() {
  const handles: SubprocessHandle[] = []

  function spawnHandle(spec: SubprocessSpawnSpec): SubprocessHandle {
    const argv = spec.argv.map(String)
    const child = spawn(argv[0], argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env ? { PATH: process.env.PATH, HOME: process.env.HOME, ...spec.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const handle = {
      pid: child.pid ?? -1,
      stdin: undefined,
      stdout: child.stdout,
      stderr: child.stderr,
      collected: {} as SubprocessHandle['collected'],
      done: new Promise<{ exitCode: number | null; signal: string | null }>(
        (resolve) => {
          child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
          child.on('error', () => resolve({ exitCode: null, signal: 'SIGSEGV' }))
        },
      ),
      terminate: () => {
        child.kill('SIGKILL')
      },
    } as unknown as SubprocessHandle
    handles.push(handle)
    return handle
  }

  return {
    spawn: spawnHandle,
    handleCount: () => handles.length,
    terminateAll: () => handles.forEach((h) => h.terminate()),
  }
}

describe('e2e: PII reference agent through the real bridge', () => {
  const root = agentRoot()
  let server: ReturnType<typeof createServer> | null = null
  let fixtureUrl = ''
  let services: ReturnType<typeof makeRealSubprocess>

  beforeAll(async () => {
    expect(root).not.toBeNull()
    services = makeRealSubprocess()
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'success',
        risk_category: 'LOW',
        sanitized_content: '[REDACTED — fixture response]',
        detections: [{ type: 'email', value: 'x@y.z', replacement: '[EMAIL]' }],
      }))
    })
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const addr = server!.address()
        if (typeof addr === 'object' && addr !== null) {
          fixtureUrl = `http://127.0.0.1:${addr.port}`
          resolve()
        }
      })
    })
  })

  afterAll(async () => {
    services.terminateAll()
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  })

  it('run 1 — fail-closed: unreachable API base is a deterministic error', async () => {
    // Import the built bridge so this test exercises the same code the
    // plugin ships (lib/), not a recompiled dev copy.
    const { runAgent } = await import('../lib/bridge.js')
    const { loadRegistry } = await import('../lib/registry.js')
    const { evaluatePermission } = await import('../lib/permissions.js')

    const reg = loadRegistry(join(here, '../agents/registry.yaml'))
    expect(reg.ok).toBe(true)
    if (!reg.ok) throw new Error('registry load failed')
    const entry = reg.registry['pii-sanitization']
    expect(entry).toBeDefined()

    // The registry points `root` at the real checkout; make sure it matches
    // what we resolved here, otherwise the test is verifying the wrong agent.
    const perm = evaluatePermission(entry, { network: true })
    expect(perm.allowed).toBe(true)

    const result = await runAgent(
      { ...entry, root: root! },
      {
        agent_id: 'pii-sanitization',
        task: 'sanitize: Call me at 555-123-4567, email a@b.com',
        context: { TRUSTBOOST_API_BASE: 'http://127.0.0.1:1' },
        // The agent's own requests.post timeout is 30s, so the bridge budget
        // must exceed it or the bridge kills the process before the agent can
        // reach its fail-closed branch. See e2e-constants.ts for measured rationale.
        timeout_ms: BRIDGE_E2E_TIMEOUT_MS,
      },
      { subprocess: services as never, logger: console },
      perm,
    )

    // The agent's fail-closed path prints a structured JSON error and exits 0.
    expect(result.status).toBe('success')
    if (result.status === 'success') {
      const r = result.result as Record<string, unknown>
      expect(r.status).toBe('error')
      expect(r.risk_category).toBe('CRITICAL')
      expect(String(r.sanitized_content)).toContain('REDACTED')
      expect(result.metadata.exit_code).toBe(0)
      expect(result.metadata.agent_version).toBe(entry.version)
    }
  }, VITEST_E2E_BUDGET_MS)

  it('run 2 — success: local fixture stands in for the TrustBoost API', async () => {
    const { runAgent } = await import('../lib/bridge.js')
    const { loadRegistry } = await import('../lib/registry.js')
    const { evaluatePermission } = await import('../lib/permissions.js')

    const reg = loadRegistry(join(here, '../agents/registry.yaml'))
    expect(reg.ok).toBe(true)
    if (!reg.ok) throw new Error('registry load failed')
    const entry = reg.registry['pii-sanitization']

    const perm = evaluatePermission(entry, { network: true })
    expect(perm.allowed).toBe(true)

    const result = await runAgent(
      { ...entry, root: root! },
      {
        agent_id: 'pii-sanitization',
        task: 'sanitize: user@example.com',
        context: { TRUSTBOOST_API_BASE: fixtureUrl },
        timeout_ms: 30000,
      },
      { subprocess: services as never, logger: console },
      perm,
    )

    expect(result.status).toBe('success')
    if (result.status === 'success') {
      const r = result.result as Record<string, unknown>
      expect(r.status).toBe('success')
      expect(String(r.sanitized_content)).toContain('fixture response')
      expect(result.metadata.exit_code).toBe(0)
    }
  }, VITEST_E2E_BUDGET_MS)
})
