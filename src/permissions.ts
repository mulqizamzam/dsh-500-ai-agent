/**
 * Permission gate for agent execution.
 *
 * Default deny:
 *   - network: false
 *   - filesystem: null (no access)
 *   - shell: false
 *   - secrets: [] (no env forwarded)
 *
 * The bridge must check the requested permission against the agent's registry
 * entry BEFORE spawning. If the request asks for a permission the agent has
 * not been granted, the bridge refuses with a structured error.
 *
 * Network permission special-case:
 *   Even when `permissions.network === true`, the bridge DOES NOT forward
 *   sensitive env names (matching /KEY|PASSWORD|SECRET|TOKEN/i) from the
 *   host environment — they are scrubbed by `ctx.subprocess` anyway. The
 *   bridge only forwards explicitly-listed `permissions.secrets`.
 */

import type { AgentRegistryEntry, AgentPermissions } from './types.js'

export interface PermissionRequest {
  network?: boolean
  /**
   * Requested filesystem mode. Mirrors the registry vocabulary (including
   * 'none' for an explicit no-access request); a request narrower than the
   * agent's grant is honoured, never widened.
   */
  filesystem?: 'read' | 'readwrite' | 'none' | null
  filesystemPaths?: string[]
  shell?: boolean
  secrets?: string[]
}

/** Result of permission evaluation. */
export interface PermissionResult {
  /** Whether all requested permissions are granted. */
  allowed: boolean
  /** List of denied capabilities (empty when allowed). */
  denied: string[]
  /** Final merged permissions applied to the subprocess spec. */
  granted: AgentPermissions
}

/**
 * Evaluate whether an agent invocation may proceed given the request.
 *
 * Rules:
 *  1. Never grant MORE than what the agent's registry declares.
 *  2. Never allow filesystem mode that is stricter than 'read' without explicit grant.
 *  3. `shell: true` requires the agent to declare `permissions.shell === true`.
 *  4. `network: true` requires the agent to declare `permissions.network === true`.
 *  5. `secrets` list from request must be a subset of `permissions.secrets`.
 */
export function evaluatePermission(
  agent: AgentRegistryEntry,
  request: PermissionRequest,
): PermissionResult {
  const denied: string[] = []
  const granted: AgentPermissions = {
    network: false,
    filesystem: null,
    shell: false,
    secrets: [],
  }

  // ── Network ──────────────────────────────────────────────
  // When the request names no preference, inherit the agent's own declaration
  // (same fallback `secrets` already uses). Without this, every silent call —
  // which is the normal one since run_agent never sends `network` — would
  // collapse to false, the bridge would inject --unshare-net, and any agent
  // that needs an API call would die with APIConnectionError.
  const reqNetwork = request.network ?? agent.permissions.network
  if (reqNetwork && !agent.permissions.network) {
    denied.push('network')
  } else {
    granted.network = reqNetwork
  }

  // ── Shell ────────────────────────────────────────────────
  const reqShell = request.shell ?? false
  if (reqShell && !agent.permissions.shell) {
    denied.push('shell')
  } else {
    granted.shell = reqShell
  }

  // ── Filesystem ───────────────────────────────────────────
  const reqFsMode = request.filesystem ?? null
  const reqFsPaths = request.filesystemPaths ?? []

  if (reqFsMode !== null && reqFsMode !== undefined) {
    const agentFs = agent.permissions.filesystem
    if (agentFs === null || agentFs.mode === 'none') {
      denied.push('filesystem')
    } else if (
      reqFsMode === 'readwrite' &&
      agentFs.mode !== 'readwrite'
    ) {
      // Requester wants rw but agent only grants r/o
      denied.push('filesystem')
    } else if (reqFsMode === 'none') {
      // Requester explicitly asks for no access at all: honoured verbatim,
      // never widened back to the agent's declaration.
      granted.filesystem = { mode: 'none', paths: [] }
    } else if (reqFsMode === 'read' && agentFs.mode === 'readwrite') {
      // Requester asks narrower than the agent declares: honour the request.
      // The grant now drives real confinement (bwrap bind mode / sandbox
      // policy), so widening a "read" request back to readwrite would
      // silently hand out writes the caller did not ask for.
      granted.filesystem = { mode: 'read', paths: agentFs.paths }
    } else if (reqFsPaths.length > 0 && agentFs.paths) {
      // Validate each requested path is within the agent's declared paths
      const allowedPaths = new Set(agentFs.paths)
      const filtered = reqFsPaths.filter((p) => allowedPaths.has(p))
      if (filtered.length !== reqFsPaths.length) {
        denied.push('filesystem')
      } else {
        granted.filesystem = { mode: reqFsMode, paths: filtered }
      }
    } else {
      granted.filesystem = agentFs
    }
  } else {
    granted.filesystem = agent.permissions.filesystem
  }

  // ── Secrets ──────────────────────────────────────────────
  // Grant the agent's declared secret list (not just the request subset).
  // This is the intentional "capability-declared" model: if the registry says
  // this agent needs TRUSTBOOST_API_BASE, the bridge passes it through
  // automatically — the operator is authorising that via registry consent,
  // not per-call opt-in. The request's secrets field is still honoured
  // (superset requests are denied), but the default granted set is the
  // agent's own declaration.
  const agentSecrets = new Set(agent.permissions.secrets)
  // If the request names no secrets, the agent's own declaration is the grant
  // (capability-declared model: the registry already authorised them).
  // If the request names secrets, they must all be declared — an undeclared
  // name is a denial, and a declared subset is granted.
  const reqSecrets = request.secrets
  if (reqSecrets === undefined || reqSecrets.length === 0) {
    granted.secrets = [...agent.permissions.secrets]
  } else {
    const extra = reqSecrets.filter((s) => !agentSecrets.has(s))
    if (extra.length > 0) {
      denied.push('secrets')
    } else {
      granted.secrets = reqSecrets.filter((s) => agentSecrets.has(s))
    }
  }

  return {
    allowed: denied.length === 0,
    denied,
    granted,
  }
}
