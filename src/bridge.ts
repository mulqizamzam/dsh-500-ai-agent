/**
 * Agent Bridge: spawns an agent process in an isolated Python venv with
 * permission enforcement, timeout, and structured output capture.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { AgentRegistryEntry } from './types.js'
import { ensureVenv } from './runtime-manager.js'
import type { PermissionResult } from './permissions.js'

/** Output shape of a successful agent execution. */
export interface AgentResult {
  status: 'success'
  result: unknown
  artifacts: string[]
  metadata: AgentMetadata
}

/** Output shape when the agent fails. */
export interface AgentError {
  status: 'error'
  error: { code: string; message: string; details?: unknown }
  metadata: AgentMetadata
}

/** Output shape on timeout. */
export interface AgentTimeout {
  status: 'timeout'
  error: { code: 'AGENT_TIMEOUT'; message: string }
  metadata: AgentMetadata
}

/** Unified output contract per FR-02. */
export type AgentInvocationResult = AgentResult | AgentError | AgentTimeout

/** Observation data for every invocation (FR-08). */
export interface AgentMetadata {
  execution_id: string
  agent_id: string
  agent_version: string
  started_at: number
  duration_ms: number
  status: string
  exit_code: number | null
  signal: string | null
  tools_used: string[]
  error?: string
}

/** Input to run_agent. */
export interface AgentInvocationInput {
  agent_id: string
  task: string
  context?: Record<string, unknown>
  timeout_ms?: number
}

/** Service shape required by the bridge. */
export interface BridgeServices {
  subprocess: { spawn(spec: SubprocessSpawnSpec): SubprocessHandle }
  sandbox?: { confine(argv: readonly string[], policy: import('@deepseek-ai/dsh-sandbox').SandboxPolicy): import('@deepseek-ai/dsh-sandbox').ConfinedArgv }
  logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void; error(msg: string, ...args: unknown[]): void }
  /**
   * Writable directory the runtime manager uses when an agent's own root is
   * read-only and the per-agent venv cannot live next to its source.
   */
  workspaceRoot: string
}

/**
 * Run an agent from the registry with full lifecycle management.
 */
export async function runAgent(
  entry: AgentRegistryEntry,
  input: AgentInvocationInput,
  services: BridgeServices,
  permissionResult: PermissionResult,
): Promise<AgentInvocationResult> {
  const executionId = randomUUID()
  const startedAt = Date.now()
  const timeoutMs = input.timeout_ms ?? entry.resources.timeout_ms

  const metadata: AgentMetadata = {
    execution_id: executionId,
    agent_id: entry.agent_id,
    agent_version: entry.version,
    started_at: startedAt,
    duration_ms: 0,
    status: 'running',
    exit_code: null,
    signal: null,
    tools_used: [],
  }

  // ── 1. Resolve Python binary (venv) ─────────────────────────────────────────
  const resolvedRoot = resolve(entry.root)
  let effectivePython: string

  // If venv is configured, use ensureVenv to materialise it before spawn.
  if (entry.venv) {
    const venvState = await ensureVenv(resolvedRoot, services.workspaceRoot, entry.agent_id, 180_000)
    if (!venvState.healthy) {
      metadata.status = 'error'
      metadata.duration_ms = Date.now() - startedAt
      metadata.error = venvState.error
      return {
        status: 'error',
        error: { code: 'VENV_UNAVAILABLE', message: venvState.error ?? 'venv preparation failed' },
        metadata,
      }
    }
    effectivePython = venvState.python
  } else {
    effectivePython = resolvePythonBinary(entry, resolvedRoot)
  }

  // ── 2. Build entrypoint command ─────────────────────────────────────────────
  const entrypoint = join(resolvedRoot, entry.entrypoint)
  const args = buildAgentArgs(entry, input)

  // ── 3. Build spawn spec (timeout signal MUST be in the spec) ────────────────
  const abortController = new AbortController()
  const spec = buildSpawnSpec(
    effectivePython,
    entrypoint,
    args,
    resolvedRoot,
    permissionResult.granted,
    input.context,
    abortController.signal,
  )

  services.logger.info(
    `[${executionId}] spawning agent "${entry.agent_id}" timeout=${timeoutMs}ms python=${effectivePython}`,
  )

  // ── 4. Spawn (with optional sandbox confinement) ────────────────────────────
  let handle: SubprocessHandle | null = null
  let enforcement: string | undefined
  let denialSignatures: readonly string[] = []

  try {
    // Build the effective argv: if sandbox provider is available, wrap with
    // the host's bwrap/Landlock runner. The runner replaces spec.argv[0] with
    // the wrapped argv — the DSH subprocess service spawns a *new* process
    // whose argv[0] is the runner, not Python directly.
    let finalArgv = spec.argv

    // Network denial is enforced at the process level: a fresh network
    // namespace means the child cannot reach any external socket — DNS,
    // HTTP, anything. This is the ONLY way to turn "network: false" from a
    // cosmetic env-var gap into an actual barrier. `--unshare-net` is a
    // bwrap flag, so HOW it can be layered depends on which runner is in
    // front of the argv — see the three cases below.
    if (services.sandbox) {
      const policy = {
        mode: 'workspace-write' as const,
        workspaceRoot: resolvedRoot,
      }
      const confinedResult = services.sandbox.confine(finalArgv, policy)
      finalArgv = confinedResult.argv
      enforcement = confinedResult.enforcement
      denialSignatures = confinedResult.denialSignatures
      services.logger.info(`[${executionId}] sandbox=on enforcement=${enforcement} denial_sigs=${denialSignatures.length}`)
    }
    if (!permissionResult.granted.network) {
      if (finalArgv[0] === 'bwrap') {
        // The runner IS bwrap: `--unshare-net` is one of its own flags, so it
        // joins the existing profile ahead of the `--` separator. Wrapping the
        // bwrap argv in a second bwrap does not nest: the inner runner would
        // re-exec bwrap as the payload and the resulting profile is not a
        // reliable confinement.
        const separator = finalArgv.indexOf('--')
        const profileFlags = separator === -1 ? finalArgv.slice(1) : finalArgv.slice(1, separator)
        if (profileFlags.includes('--unshare-net')) {
          services.logger.info(`[${executionId}] network=denied unshare-net already in bwrap profile`)
        } else {
          finalArgv = ['bwrap', '--unshare-net', ...finalArgv.slice(1)]
          services.logger.info(`[${executionId}] network=denied unshare-net active`)
        }
      } else if (services.sandbox) {
        // A non-bwrap runner (Landlock, Seatbelt, windows-acl) is in front.
        // Its flag dialect is not bwrap's, so `--unshare-net` cannot be
        // injected, and a bwrap wrapper around it would not nest. Rather than
        // emit an argv that looks confined but is not, report the gap: the
        // filesystem policy is still enforced, the network denial is NOT.
        enforcement = 'partial'
        services.logger.warn(
          `[${executionId}] network=denied but runner="${finalArgv[0]}" is not bwrap: network denial NOT enforced, enforcement=partial`,
        )
      } else {
        // No sandbox provider. `--unshare-net` alone would leave the agent
        // with full read access to the host filesystem, so build the full
        // profile: host read-only, a private /dev, a tmpfs /tmp, and the
        // agent root as the only writable path.
        finalArgv = [
          'bwrap', '--unshare-net',
          '--ro-bind', '/', '/',
          '--dev', '/dev',
          '--tmpfs', '/tmp',
          '--bind', resolvedRoot, resolvedRoot,
          '--die-with-parent',
          ...finalArgv,
        ]
        services.logger.info(`[${executionId}] network=denied unshare-net active fallback=bwrap-fallback root=${resolvedRoot}`)
      }
    }

    const finalSpec: SubprocessSpawnSpec = { ...spec, argv: finalArgv }
    handle = services.subprocess.spawn(finalSpec)
  } catch (e) {
    const err = e as Error
    metadata.status = 'error'
    metadata.error = `spawn failed: ${err.message}`
    metadata.duration_ms = Date.now() - startedAt
    if ((err as { code?: string }).code === 'SANDBOX_UNAVAILABLE') {
      return {
        status: 'error',
        error: { code: 'SANDBOX_UNAVAILABLE', message: err.message },
        metadata,
      }
    }
    return { status: 'error', error: { code: 'SPAWN_FAILED', message: err.message }, metadata }
  }

  // ── 5. Timeout enforcement ──────────────────────────────────────────────────
  // The abort signal is already in the spec, so the subprocess seam reacts by
  // escalating terminate on the process tree. We still race so a hung process
  // cannot hang the caller: when the abort wins, we terminate explicitly and
  // answer with AGENT_TIMEOUT instead of waiting forever.
  let timedOut = false
  const onAbort = (): void => { timedOut = true }
  abortController.signal.addEventListener('abort', onAbort, { once: true })
  const timeoutTimer = setTimeout(() => abortController.abort(), timeoutMs)

  const stdoutP = collectStream(handle.stdout)
  const stderrP = collectStream(handle.stderr)

  try {
    const outcome = await raceWithAbort(handle, abortController.signal)

    metadata.exit_code = outcome.exitCode
    metadata.signal = outcome.signal
    metadata.duration_ms = Date.now() - startedAt

    if (timedOut) {
      services.logger.warn(`[${executionId}] agent timed out after ${timeoutMs}ms, terminating`)
      handle.terminate()
      metadata.status = 'timeout'
      metadata.error = `AGENT_TIMEOUT after ${timeoutMs}ms`
      return {
        status: 'timeout',
        error: { code: 'AGENT_TIMEOUT', message: `agent "${entry.agent_id}" exceeded ${timeoutMs}ms` },
        metadata,
      }
    }

    const [stdout, stderr] = await Promise.all([stdoutP, stderrP])
    metadata.status = outcome.exitCode === 0 ? 'success' : 'error'

    if (outcome.exitCode !== 0) {
      services.logger.warn(
        `[${executionId}] agent exited with code ${outcome.exitCode}: ${stderr.slice(0, 200)}`,
      )
      return {
        status: 'error',
        error: {
          code: 'AGENT_EXIT_ERROR',
          message: `Process exited with code ${outcome.exitCode}`,
          details: { exitCode: outcome.exitCode, stderr },
        },
        metadata,
      }
    }

    return validateAndParseOutput(stdout, metadata)
  } catch (e) {
    metadata.duration_ms = Date.now() - startedAt
    if (timedOut) {
      metadata.status = 'timeout'
      handle.terminate()
      return {
        status: 'timeout',
        error: { code: 'AGENT_TIMEOUT', message: `agent "${entry.agent_id}" exceeded ${timeoutMs}ms` },
        metadata,
      }
    }
    metadata.status = 'error'
    const err = e as Error
    services.logger.error(`[${executionId}] collection error: ${err.message}`)
    return { status: 'error', error: { code: 'COLLECTION_ERROR', message: err.message }, metadata }
  } finally {
    clearTimeout(timeoutTimer)
    abortController.signal.removeEventListener('abort', onAbort)
    // Cleanup must never block on a still-running process: race the exit
    // facts against a short grace window, then terminate unconditionally.
    if (handle) {
      const exited = await Promise.race([
        handle.done.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ])
      if (!exited) {
        services.logger.warn(`[${executionId}] process still alive after collection, forcing terminate`)
        handle.terminate()
      }
    }
  }
}

/**
 * Race the exit facts against an abort, so a process that never settles
 * cannot hang the caller past its own timeout.
 */
async function raceWithAbort(
  handle: SubprocessHandle,
  signal: AbortSignal,
): Promise<{ exitCode: number | null; signal: string | null }> {
  if (signal.aborted) {
    return { exitCode: null, signal: 'SIGKILL' }
  }
  return new Promise((resolve, reject) => {
    handle.done.then(resolve, reject)
    const onAbort = (): void => resolve({ exitCode: null, signal: 'SIGKILL' })
    signal.addEventListener('abort', onAbort, { once: true })
    void handle.done.then(
      () => signal.removeEventListener('abort', onAbort),
      () => signal.removeEventListener('abort', onAbort),
    )
  })
}

/** Resolve the Python binary for this agent. */
function resolvePythonBinary(entry: AgentRegistryEntry, agentRoot: string): string {
  if (entry.venv) {
    const venvPython = join(agentRoot, entry.venv, 'bin', 'python')
    if (existsSync(venvPython)) return venvPython
  }
  return 'python3'
}

/**
 * Build CLI args for the agent from the request.
 *
 * `entrypoint_args` is a positional argv template — each element is either a
 * literal or a `{{name}}` placeholder. Placeholders resolve against the
 * invocation inputs: `task` and `timeout_ms` come from the request itself, any
 * other name from `context`. An argv element is passed to execve verbatim, so
 * a resolved value never needs quoting; wrapping it in quotes would put the
 * quote characters into the argument itself.
 */
function buildAgentArgs(entry: AgentRegistryEntry, input: AgentInvocationInput): string[] {
  const args: string[] = []
  if (entry.entrypoint_args && entry.entrypoint_args.length > 0) {
    for (const tmpl of entry.entrypoint_args) {
      if (typeof tmpl === 'string' && tmpl.startsWith('{{') && tmpl.endsWith('}}')) {
        const key = tmpl.slice(2, -2)
        const value =
          key === 'task' ? input.task
          : key === 'timeout_ms' ? input.timeout_ms
          : input.context?.[key]
        if (value !== undefined) args.push(String(value))
      } else {
        args.push(String(tmpl))
      }
    }
  } else {
    args.push('--task', input.task)
  }
  return args
}

/** Build SubprocessSpawnSpec with permission-gated env. */
function buildSpawnSpec(
  pythonBin: string,
  entrypoint: string,
  args: string[],
  cwd: string,
  permissions: AgentRegistryEntry['permissions'],
  context: Record<string, unknown> | undefined,
  signal: AbortSignal,
): SubprocessSpawnSpec {
  const env: Record<string, string> = {}

  // Forward granted secrets from context
  if (permissions.secrets.length > 0 && context) {
    for (const secretName of permissions.secrets) {
      const val = context[secretName]
      if (typeof val === 'string') env[secretName] = val
    }
  }

  // No env variable is forwarded unconditionally. TRUSTBOOST_API_BASE is a
  // generic name; forwarding it because some agent happens to read it would
  // make every future env override an accidental backdoor. It travels only
  // when the registry entry declares it under permissions.secrets.

  return {
    argv: [pythonBin, entrypoint, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 10_000_000, spill: { maxBytes: 50_000_000 } },
      stderr: { maxBytes: 1_000_000, spill: { maxBytes: 5_000_000 } },
    },
    graceMs: 5000,
    signal,
    env: Object.keys(env).length > 0 ? env : undefined,
  }
}

/** Collect a Readable stream into a string. */
async function collectStream(stream: Readable | undefined): Promise<string> {
  if (!stream) return ''
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/** Validate and parse agent stdout as JSON. */
function validateAndParseOutput(stdout: string, metadata: AgentMetadata): AgentInvocationResult {
  const jsonMatch = stdout.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    metadata.status = 'error'
    return {
      status: 'error',
      error: { code: 'MALFORMED_OUTPUT', message: 'Agent output does not contain valid JSON', details: { stdout: stdout.slice(0, 500) } },
      metadata,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    metadata.status = 'error'
    return {
      status: 'error',
      error: { code: 'JSON_PARSE_ERROR', message: 'Agent output contains invalid JSON', details: { raw: stdout.slice(0, 500) } },
      metadata,
    }
  }

  metadata.status = 'success'
  return { status: 'success', result: parsed, artifacts: [], metadata }
}
