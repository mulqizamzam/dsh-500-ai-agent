/**
 * ContainerRuntime — isolation backend for high-security agents.
 *
 * Uses Docker or Podman to run the agent in a fully isolated container:
 *   --network=none   → the container gets no network namespace
 *   --cap-drop=ALL   → no Linux capabilities
 *   --security-opt=no-new-privileges:true
 *   --read-only      → read-only rootfs
 *   -v <agentRoot>:/agent:ro → agent code mounted read-only
 *
 * If no container runtime binary is available on this host, the result
 * carries an explicit `error` signal (empty argv, confined: false) so
 * callers can act on it — never `argv: []` with `confined: true`.
 *
 * tmpfs / venv decision (documented): `--tmpfs /tmp` is intentionally NOT
 * added. A `--read-only` rootfs freezes the venv, so any agent that writes
 * into its venv (pip installs, caches) breaks under it — and `--tmpfs
 * /tmp` would not fix that, it only makes /tmp writable while the venv
 * stays frozen. tmpfs is therefore only useful if the venv is also
 * mounted read-write, which is out of scope here. Agents that must write
 * are expected to opt in via a future `writableWorkspace` option; the
 * default is fail-safe read-only.
 */

import { spawnSync } from 'node:child_process'

export interface ContainerRuntimeConfig {
  /** Which runtime to use: 'docker' or 'podman'. */
  runtime: 'docker' | 'podman'
  /** Override the image used. Defaults to `python:3.11-slim`. */
  image?: string
  /** Extra args passed to the runtime (inserted before the image). */
  extraArgs?: string[]
  /** Whether to mount the agent root read-only and freeze the rootfs. */
  readOnlyAgentRoot: boolean
  /** Absolute path to the agent root directory (mounted at /agent). */
  agentRoot: string
  /** Agent entrypoint filename relative to agentRoot. */
  entrypoint: string
  /** CLI args assembled by the bridge. */
  args: string[]
  /**
   * Test seam / host override for runtime detection. Defaults to the real
   * probe, which `spawnSync`s `<binary> --version` for each candidate in
   * order and returns the first that exits 0. Tests may inject a fixed
   * answer to keep assertions host-independent.
   */
  runtimeProbe?: (candidates: readonly string[]) => string | null
}

export interface ContainerBuildResult {
  argv: string[]
  /** Host working directory for the runtime client process. */
  cwd: string
  /** True only when a container runtime was actually available. */
  confined: boolean
  /** Present and 'full' only when `confined` is true. */
  enforcement?: 'full' | 'partial'
  denialSignatures: string[]
  /**
   * True when the container gets no network namespace. Container configs
   * always use `--network=none`, so this is true on both the confined and
   * the runtime-unavailable paths (in the latter case nothing runs at all,
   * which is at least as strict).
   */
  networkDenied: boolean
  /**
   * Set when no container runtime binary is available on this host.
   * When present, `argv` is empty and `confined` is false — callers MUST
   * not spawn this config and must handle the error explicitly.
   */
  error?: string
}

/**
 * Probe whether a container runtime binary exists on this host.
 * Uses `spawnSync` to invoke the binary directly (no shell string):
 * `<binary> --version` exiting 0 with no spawn error means available.
 *
 * @returns the first candidate that is available, or `null` if none.
 */
export function findAvailableRuntime(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    if (result.error === undefined && result.status === 0) {
      return candidate
    }
  }
  return null
}

/**
 * Build a container-backed spawn configuration for one agent invocation.
 *
 * Unavailable-runtime signal: when neither `docker` nor `podman` is found
 * on this host, returns `{ argv: [], confined: false, error: '...' }`.
 * Never returns `argv: []` alongside `confined: true` / `enforcement:
 * 'full'` — the old stub did exactly that and would let a caller report
 * a container-protected run that never happened.
 *
 * Available-runtime argv shape (readOnlyAgentRoot: true):
 *   [runtime, 'run', '--rm', '--network=none', '--cap-drop=ALL',
 *    '--security-opt=no-new-privileges:true', '--read-only',
 *    '-v', '<agentRoot>:/agent:ro', '-w', '/agent',
 *    ...extraArgs, image, 'python3', '/agent/<entrypoint>', ...args]
 */
export function buildContainerConfig(opts: ContainerRuntimeConfig): ContainerBuildResult {
  const { runtime, image, extraArgs, readOnlyAgentRoot, agentRoot, entrypoint, args } = opts
  const probe = opts.runtimeProbe ?? findAvailableRuntime
  const availableRuntime = probe([runtime, runtime === 'docker' ? 'podman' : 'docker'])

  if (availableRuntime === null) {
    return {
      argv: [],
      cwd: agentRoot,
      confined: false,
      denialSignatures: [],
      networkDenied: true,
      error: "container runtime unavailable: neither 'docker' nor 'podman' found on this host",
    }
  }

  const flags: string[] = [
    '--rm',
    '--network=none',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
  ]
  if (readOnlyAgentRoot) {
    flags.push('--read-only')
  }
  // Agent root is mounted read-only in both cases: agents never need to
  // mutate their own code. --read-only additionally freezes the rootfs.
  flags.push('-v', `${agentRoot}:/agent:ro`)
  flags.push('-w', '/agent')
  if (extraArgs && extraArgs.length > 0) {
    flags.push(...extraArgs)
  }

  const argv: string[] = [
    availableRuntime,
    'run',
    ...flags,
    image ?? 'python:3.11-slim',
    'python3',
    `/agent/${entrypoint}`,
    ...args,
  ]

  return {
    argv,
    cwd: agentRoot,
    confined: true,
    enforcement: 'full',
    denialSignatures: [],
    networkDenied: true,
  }
}
