/**
 * RuntimeBackend — abstraction for how an agent Python process is executed.
 *
 * Three backends in this version:
 *
 *   LocalVenvRuntime  — direct python3 or <venv>/bin/python invocation.
 *                       Fast, no extra isolation beyond the agent root.
 *
 *   BubblewrapRuntime — wraps the argv in `bwrap --unshare-net` (network
 *                       denial) plus the DSH sandbox confinement when
 *                       `ctx.sandbox` is available. Best tradeoff between
 *                       isolation and performance.
 *
 *   ContainerRuntime  — wraps the agent in a docker/podman container
 *                       (--network=none --cap-drop=ALL --read-only, agent
 *                       root mounted at /agent:ro). When no container
 *                       runtime binary is available on the host,
 *                       buildRuntimeConfig() returns an explicit `error`
 *                       signal instead of degrading to an unconfined run.
 *
 * The bridge (src/bridge.ts) selects the backend via `config.runtimeBackend`
 * in the plugin config. Default: `"bubblewrap"`.
 *
 * IMPORTANT: PID isolation (--unshare-pid) is already present in the DSH
 * sandbox profile, so process-tree visibility is already limited. What
 * remains is:
 *   - network   (handled by --unshare-net)
 *   - filesystem (handled by sandbox bwrap --ro-bind / / --bind <agent_root>)
 *   - exec      (Python os.system / subprocess still works — seccomp filter
 *                would be needed to deny, not implemented in v1)
 */

import type { SandboxPolicy, ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import { buildContainerConfig } from './container-runtime.js'
import type { EnforcementLevel } from './types.js'
import { applyNetworkDenial } from './network-denial.js'

export type { EnforcementLevel } from './types.js'

/** How the bridge decides to spawn the agent process. */
export type RuntimeBackend = 'local' | 'bubblewrap' | 'container'

/**
 * Enforcement completeness for a confined run now lives in ./types.js (the
 * shared type home) so the bridge, this module, and the network-denial
 * helper cannot each carry a slightly different copy; re-exported above for
 * backwards compatibility.
 */

/**
 * Result of configuring a runtime backend for one agent invocation.
 */
export interface RuntimeBackendConfig {
  /** The argv to spawn — may be the raw Python argv or a bwrap-wrapped argv. */
  argv: string[]
  /** The working directory for the subprocess. */
  cwd: string
  /** True when a sandbox provider was consulted. */
  confined: boolean
  /** Enforcement completeness when confined. */
  enforcement?: EnforcementLevel
  /** Denial stderr signatures to classify sandbox denial vs runner failure. */
  denialSignatures: string[]
  /** True when the agent's network permission was actually denied. */
  networkDenied: boolean
  /**
   * Set when the selected backend could not be honoured on this host.
   * When present the config must NOT be spawned as-is: `argv` is empty
   * and `confined` is false, so the caller has to decide explicitly
   * (fail the run, or opt into a weaker backend).
   */
  error?: string
}

/**
 * Build the runtime backend configuration for one agent invocation.
 *
 * @param opts  all parameters required to decide how to spawn the agent.
 */
export interface RuntimeBackendOpts {
  /** Absolute path to the Python binary (venv or system). */
  pythonBin: string
  /** Absolute path to the agent root directory. */
  agentRoot: string
  /** Agent entrypoint filename relative to agentRoot. */
  entrypoint: string
  /** CLI args assembled by the bridge. */
  args: string[]
  /** Evaluated permissions — controls network isolation and the filesystem grant. */
  permissions: { network: boolean; filesystemWritable?: boolean }
  /** DSH sandbox provider, if available in this context. */
  sandbox?: { confine: (argv: readonly string[], policy: SandboxPolicy) => ConfinedArgv }
  /** Plugin runtime-backend config, defaults to 'bubblewrap'. */
  backend: RuntimeBackend
  /** Container backend: preferred runtime binary (probed in order docker → podman). */
  containerRuntime?: 'docker' | 'podman'
  /** Container backend: image override. Defaults to `python:3.11-slim`. */
  containerImage?: string
  /**
   * Test seam / host override for container-runtime detection, passed
   * through to `buildContainerConfig`. Defaults to the real probe.
   */
  containerRuntimeProbe?: (candidates: readonly string[]) => string | null
}

/**
 * Build argv + cwd based on the selected backend.
 *
 * Local: returns argv as-is (python3 + entrypoint + args).
 * Bubblewrap:
 *   - If sandbox available: call sandbox.confine() → bwrap or Landlock runner,
 *     under the policy matching the agent's filesystem grant.
 *   - If network denied: the shared applyNetworkDenial() helper injects
 *     --unshare-net into the existing runner, reports a non-bwrap runner gap,
 *     or builds the full fallback profile — depending on the runner shape.
 * Container: delegates to `buildContainerConfig()`, which builds a real
 *   `docker|podman run --network=none --cap-drop=ALL --read-only …` argv
 *   when a runtime binary exists on this host, and otherwise returns an
 *   explicit `error` signal instead of silently degrading to an
 *   unconfined local run.
 */
export function buildRuntimeConfig(opts: RuntimeBackendOpts): RuntimeBackendConfig {
  const { pythonBin, agentRoot, entrypoint, args, permissions, sandbox, backend } = opts
  const baseArgv = [pythonBin, `${agentRoot}/${entrypoint}`, ...args]

  const noNetwork = !permissions.network

  if (backend === 'container') {
    const container = buildContainerConfig({
      runtime: opts.containerRuntime ?? 'docker',
      image: opts.containerImage,
      readOnlyAgentRoot: true,
      agentRoot,
      entrypoint,
      args,
      runtimeProbe: opts.containerRuntimeProbe,
    })
    if (container.error !== undefined) {
      // No container runtime on this host. Returning the raw local argv
      // here (the old behaviour) would run the agent completely
      // unconfined while the operator asked for container isolation —
      // and nothing in the result said so. Surface it instead.
      return {
        argv: [],
        cwd: agentRoot,
        confined: false,
        denialSignatures: [],
        networkDenied: true,
        error: container.error,
      }
    }
    // The container argv always carries --network=none, so the network
    // permission is denied for container runs regardless of what the
    // registry grants; networkDenied reports that truthfully.
    return container
  }

  if (backend === 'local') {
    return {
      argv: baseArgv,
      cwd: agentRoot,
      confined: false,
      denialSignatures: [],
      // The local backend applies no network control whatsoever, so the
      // denial did not happen here and must not be reported as having
      // happened — `networkDenied` describes what was enforced, not what
      // was requested. An agent needing a real network boundary must use
      // the bubblewrap backend (the default).
      networkDenied: false,
    }
  }

  // === bubblewrap (default) ===
  let confined = false
  let enforcement: EnforcementLevel | undefined
  let denialSignatures: string[] = []
  let argv = baseArgv
  const rootWritable = opts.permissions.filesystemWritable === true

  // Path 1: DSH sandbox provider — gives full file + pid isolation + optional
  // network isolation (the host's backend decides whether --unshare-net is
  // appended; we don't double-add it).
  //
  // The sandbox's own vocabulary governs FILE effects only, so the policy
  // mirrors the agent's evaluated filesystem grant: an explicit readwrite
  // grant is `workspace-write` (workspace + tmp writable); the default-deny
  // grants (null, 'read', 'none') are `read-only`, which the backend renders
  // as read-only binds with no writable root.
  if (sandbox) {
    const policy: SandboxPolicy = {
      mode: rootWritable ? 'workspace-write' : 'read-only',
      workspaceRoot: agentRoot,
    }
    const confinedResult = sandbox.confine(baseArgv, policy)
    argv = confinedResult.argv
    confined = true
    enforcement = confinedResult.enforcement
    denialSignatures = [...confinedResult.denialSignatures]
  }

  // Path 2: network denial. HOW --unshare-net can be layered depends on
  // which runner is in front of the argv — the shared helper owns all three
  // cases (inject into an existing bwrap profile / report a non-bwrap
  // runner gap / build the full fallback profile).
  if (noNetwork) {
    const denied = applyNetworkDenial({ argv, sandboxUsed: sandbox !== undefined, agentRoot, rootWritable })
    argv = denied.argv
    if (denied.enforcement !== undefined) {
      // A non-bwrap runner carries the network gap; its file confinement
      // still stands, so this is a downgrade, not a failure.
      enforcement = denied.enforcement
    }
  }

  return {
    argv,
    cwd: agentRoot,
    confined,
    enforcement,
    denialSignatures,
    networkDenied: noNetwork,
  }
}

/**
 * Shell execution boundary — CURRENT LIMITATION DOCUMENTATION.
 *
 * The current BubblewrapRuntime blocks:
 *   - network: via --unshare-net (new network namespace, no DNS/HTTP)
 *   - filesystem: via sandbox.confine() or bwrap --ro-bind / /
 *   - PID visibility: via bwrap --unshare-pid
 *
 * It does NOT block:
 *   - Python's os.system(), subprocess.call(), os.exec*() from WITHIN the
 *     child process. The child runs in its own PID namespace but retains
 *     full access to the host's executable search path.
 *
 * Why this limitation exists:
 *   - bubblewrap has no --deny-exec or seccomp filter built-in.
 *   - Landlock (Linux >= 5.13, kernel 6.18 available) can block syscalls
 *     including openat/execve, but requires a small C/Rust helper.
 *   - seccomp-bpf via Python ctypes is possible but requires LD_PRELOAD
 *     injection or wrapping the Python binary with prctl(PR_SET_NO_NEW_PRIVS)
 *     before the interpreter starts — fragile and easily bypassed.
 *
 * Future remediation options (listed by complexity):
 *   1. Wrapper script: replace python3 with a shell wrapper that rejects
 *      argv patterns matching "os.system" or "subprocess.call" at load
 *      time. NOT reliable — Python bytecode is hard to inspect without
 *      importing the module.
 *   2. LD_PRELOAD libseccomp.so shim: inject prctl(SECCOMP_SET_MODE_FILTER)
 *      before Python starts. Requires compiling a small .so per-platform.
 *   3. Container runtime (ContainerRuntime stub): Docker/podman --cap-drop=ALL
 *      --security-opt=no-new-privileges:true blocks exec unless explicitly
 *      whitelisted. This is the production-grade solution.
 *   4. Landlock runner: use @deepseek-ai/node-addon-landlock-run (already
 *      available as DSH dependency) to create a syscall-level allow-list
 *      that excludes execve. Most efficient; requires Rust/C extension.
 *
 * For Phase 2 we document the limitation explicitly and leave the
 * RuntimeBackend abstraction ready for option 4 implementation.
 */
