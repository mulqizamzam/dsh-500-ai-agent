/**
 * 500-AI-Agents registry entry types.
 *
 * A registry file (agents/registry.yaml) maps agent_id to an AgentRegistryEntry.
 * Entries are the ONLY source of truth for which agents are callable.
 * The bridge does NOT scan the filesystem for agent.py files — the registry is
 * an allow-list.
 *
 * Fields align with the project PRD FR-01 + 15 (provenance) requirements:
 *   - every agent carries `source` (repo + path + commit)
 *   - `status` gates routing: only `validated`/`production`/`experimental`
 *     are eligible for execution; `disabled` and `registered` are not.
 *
 * Security posture is default-deny: `permissions` is a nested object where
 * every leaf defaults to its closed value (network: false, filesystem: null,
 * shell: false, secrets: []). The bridge validates permissions BEFORE spawn
 * and refuses to start the subprocess if the requested agent requires
 * permission the operator has not granted.
 */

/** Lifecycle status of a registered agent. */
export type AgentStatus =
  | 'registered'    // metadata captured, not yet validated
  | 'experimental'   // invoked in smoke tests; not production-ready
  | 'validated'      // passed all lifecycle tests + output contract
  | 'production'     // approved for production routing
  | 'disabled'       // permanently disabled; bridge refuses to execute

/** Permission model: default deny, explicit opt-in. */
export interface AgentPermissions {
  /** Allow network access from the agent's isolated runtime. Default: false. */
  network: boolean
  /**
   * Filesystem access. Default: null (no access).
   * When set: `{ mode: 'read' | 'readwrite' | 'none', paths: string[] }`
   * Paths are resolved relative to the agent's root and must not escape it.
   */
  filesystem: { mode: 'read' | 'readwrite' | 'none'; paths: string[] } | null
  /** Allow shell access from the agent. Default: false. */
  shell: boolean
  /**
   * Secret names the agent may access. Default: [].
   * Only names listed here are forwarded via explicit `env` in the subprocess spec.
   */
  secrets: string[]
}

/** Resource limits for one agent invocation. */
export interface AgentResources {
  /** Maximum wall-clock duration in ms before the bridge terminates the process. Default: 120_000. */
  timeout_ms: number
  /** Maximum process tree memory in MB. 0 or omitted = no limit. */
  memory_mb?: number
}

/** Runtime descriptor: what language/runtime executes the agent. */
export interface AgentRuntime {
  /** 'python' | 'node' | 'rust' | 'shell' — DSH only supports 'python' in v1. */
  type: string
  /** e.g. "3.11" — the Python major.minor expected. */
  version: string
}

/** Provenance: where this agent came from. */
export interface AgentSource {
  /** Git repo owner/name, e.g. "ashishpatel26/500-AI-Agents-Projects". */
  repository: string
  /** Path within the repo, e.g. "agents/21-pii-sanitization-agent". */
  path: string
  /** Git commit or tag. Required for reproducible pinning. */
  commit: string
}

/** Capability tags used for capability-based routing. */
export type AgentCapability =
  | 'research'
  | 'code-review'
  | 'pii'
  | 'summary'
  | 'documentation'
  | 'security'
  | 'compliance'
  | 'qa'
  | 'data-analysis'
  | 'general'

/** One entry in agents/registry.yaml. */
export interface AgentRegistryEntry {
  /** Stable machine-readable id, e.g. "pii-sanitization". */
  agent_id: string
  /** Human-readable name. */
  name: string
  /** Semantic version of this catalog entry (NOT the agent's version). */
  version: string
  /** Runtime descriptor. */
  runtime: AgentRuntime
  /** Path to entrypoint relative to the agent's root. Typically "agent.py". */
  entrypoint: string
  /** CLI args the bridge passes to the entrypoint. Format: template with named placeholders. */
  entrypoint_args?: string[]
  /** Capability tags this agent supports. */
  capabilities: AgentCapability[]
  /** Permission grants for this agent. Default-deny if omitted. */
  permissions: AgentPermissions
  /** Resource limits. */
  resources: AgentResources
  /** Provenance: repo + path + commit. */
  source: AgentSource
  /** Lifecycle status. */
  status: AgentStatus
  /** Maturity metadata (informational; not gated on this in v1). */
  maturity?: string
  /**
   * Agent root directory. Path relative to the workspace or absolute.
   * Must contain a `agent.py` entrypoint file.
   */
  root: string
  /**
   * Python virtual environment directory. Path relative to the agent's root.
   * The bridge runs `python` from this venv, NOT from system Python.
   * If not set, system Python is used (less isolation).
   */
  venv?: string
}

/** The registry file as parsed: agent_id → entry. */
export type AgentRegistry = Record<string, AgentRegistryEntry>

/**
 * Enforcement completeness for a confined run. Mirrors the DSH sandbox
 * vocabulary (`SandboxEnforcement`) so a provider value can be carried
 * through without a cast. `full` means the policy holds on every promised
 * effect; `partial` means some effect is unguarded and the caller must not
 * treat this as an absolute boundary.
 */
export type EnforcementLevel = 'full' | 'partial'

/**
 * Parse-time result: either success with registry data, or a list of validation errors.
 * Never throws — the bridge catches errors and returns structured failure.
 */
export type RegistryParseResult =
  | { ok: true; registry: AgentRegistry }
  | { ok: false; errors: string[] }
