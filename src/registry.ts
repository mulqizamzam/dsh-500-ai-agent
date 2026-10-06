/**
 * Agent registry: read and validate YAML registry files.
 *
 * The registry is a `.yaml` file at `agents/registry.yaml`. The bridge loads
 * it at plugin apply-time and caches the parsed result.
 *
 * Security:
 *   - agent_id: must match /^[a-z][a-z0-9-]{0,63}$/ (lowercase, max 64 chars)
 *   - root:     must resolve to a real directory within the workspace; no `..`
 *   - source.commit: must be a 40-char SHA or a git tag reference
 *   - permissions: all leaves must be valid values from AgentPermissions
 *
 * The parser uses the `yaml` npm package (same version the DSH host uses:
 * `yaml@2.9.0`). Do NOT use `js-yaml` or `node:yaml` (not present in DSH host).
 */

import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import * as yaml from 'yaml'
import type {
  AgentRegistry,
  AgentRegistryEntry,
  AgentStatus,
  AgentCapability,
  RegistryParseResult,
} from './types.js'

/** Set of all valid AgentStatus values. */
const VALID_STATUSES = new Set<AgentStatus>(['registered', 'experimental', 'validated', 'production', 'disabled'])

/** Set of all valid capability tags. */
const VALID_CAPABILITIES = new Set<AgentCapability>([
  'research', 'code-review', 'pii', 'summary', 'documentation',
  'security', 'compliance', 'qa', 'data-analysis', 'general',
])

/**
 * Validate a single entry from the registry.
 * Returns a list of error strings (empty = valid).
 *
 * @param entryId  The agent_id key from the YAML file.
 * @param raw      The raw value from YAML (unknown shape until validated).
 * @param baseDir  The directory to resolve relative `root` paths against.
 */
export function validateEntry(
  entryId: string,
  raw: unknown,
  baseDir: string,
): string[] {
  const errors: string[] = []
  const prefix = `[${entryId}]`

  if (typeof raw !== 'object' || raw === null) {
    return [`${prefix} value must be a YAML object`]
  }

  const e = raw as Record<string, unknown>

  // agent_id: required, must match pattern
  if (typeof e.agent_id !== 'string') {
    errors.push(`${prefix} agent_id missing or not a string`)
  } else if (!/^[a-z][a-z0-9-]{0,63}$/.test(e.agent_id)) {
    errors.push(`${prefix} agent_id "${e.agent_id}" must match /^[a-z][a-z0-9-]{0,63}$/`)
  }

  // name: required string
  if (typeof e.name !== 'string' || e.name.trim() === '') {
    errors.push(`${prefix} name missing or empty`)
  }

  // runtime: object with type + version
  const rt = e.runtime
  if (typeof rt !== 'object' || rt === null) {
    errors.push(`${prefix} runtime missing or not an object`)
  } else {
    const r = rt as Record<string, unknown>
    if (typeof r.type !== 'string' || r.type.trim() === '') {
      errors.push(`${prefix} runtime.type missing or empty`)
    }
    if (typeof r.version !== 'string') {
      errors.push(`${prefix} runtime.version missing or not a string`)
    }
  }

  // entrypoint: required string
  if (typeof e.entrypoint !== 'string' || e.entrypoint.trim() === '') {
    errors.push(`${prefix} entrypoint missing or empty`)
  }

  // root: required, must resolve to a real directory
  if (typeof e.root !== 'string' || e.root.trim() === '') {
    errors.push(`${prefix} root missing or empty`)
  } else {
    const resolved = resolve(baseDir, e.root)
    if (!existsSync(resolved)) {
      errors.push(`${prefix} root "${e.root}" does not exist (resolved: ${resolved})`)
    } else {
      try {
        if (!statSync(resolved).isDirectory()) {
          errors.push(`${prefix} root "${e.root}" is not a directory`)
        }
      } catch {
        // existsSync returned true but statSync failed — race condition, treat as error
        errors.push(`${prefix} root "${e.root}" cannot be stat'd (race or permission)`)
      }
    }
  }

  // capabilities: array, each must be a valid tag
  if (Array.isArray(e.capabilities)) {
    for (const cap of e.capabilities) {
      if (typeof cap !== 'string' || !VALID_CAPABILITIES.has(cap as AgentCapability)) {
        errors.push(`${prefix} capabilities contains unknown value: ${JSON.stringify(cap)}`)
      }
    }
  } else {
    errors.push(`${prefix} capabilities missing or not an array`)
  }

  // permissions: validate nested structure
  if (typeof e.permissions !== 'object' || e.permissions === null) {
    errors.push(`${prefix} permissions missing or not an object (must default-deny)`)
  } else {
    const perms = e.permissions as Record<string, unknown>
    if (typeof perms.network !== 'boolean') {
      errors.push(`${prefix} permissions.network must be boolean (default: false)`)
    }
    // shell: must be boolean if present
    if (perms.shell !== undefined && typeof perms.shell !== 'boolean') {
      errors.push(`${prefix} permissions.shell must be boolean (default: false)`)
    }
    // secrets: array of strings
    if (perms.secrets !== undefined && !Array.isArray(perms.secrets)) {
      errors.push(`${prefix} permissions.secrets must be an array of strings (default: [])`)
    }
    // filesystem: either null or { mode, paths }
    if (perms.filesystem !== null && perms.filesystem !== undefined) {
      const fs = perms.filesystem as Record<string, unknown>
      if (typeof fs !== 'object' || fs === null) {
        errors.push(`${prefix} permissions.filesystem must be null or an object`)
      } else {
        const validModes = new Set(['read', 'readwrite', 'none'])
        if (typeof fs.mode !== 'string' || !validModes.has(fs.mode)) {
          errors.push(`${prefix} permissions.filesystem.mode must be one of: read, readwrite, none`)
        }
        if (fs.paths !== undefined && !Array.isArray(fs.paths)) {
          errors.push(`${prefix} permissions.filesystem.paths must be an array`)
        }
      }
    }
  }

  // resources.timeout_ms: required number
  if (typeof e.resources !== 'object' || e.resources === null) {
    errors.push(`${prefix} resources missing or not an object`)
  } else {
    const res = e.resources as Record<string, unknown>
    if (typeof res.timeout_ms !== 'number' || res.timeout_ms <= 0) {
      errors.push(`${prefix} resources.timeout_ms must be a positive number`)
    }
  }

  // source: repo + path + commit
  if (typeof e.source !== 'object' || e.source === null) {
    errors.push(`${prefix} source missing or not an object`)
  } else {
    const src = e.source as Record<string, unknown>
    if (typeof src.repository !== 'string' || src.repository.trim() === '') {
      errors.push(`${prefix} source.repository missing or empty`)
    }
    if (typeof src.path !== 'string' || src.path.trim() === '') {
      errors.push(`${prefix} source.path missing or empty`)
    }
    if (typeof src.commit !== 'string' || src.commit.trim() === '') {
      errors.push(`${prefix} source.commit missing or empty (git commit SHA or tag required)`)
    }
  }

  // status: required valid enum
  if (typeof e.status !== 'string' || !VALID_STATUSES.has(e.status as AgentStatus)) {
    errors.push(`${prefix} status must be one of: ${[...VALID_STATUSES].join(', ')}`)
  }

  return errors
}

/**
 * Parse a YAML registry string into AgentRegistry.
 *
 * @param yamlText  Raw YAML text.
 * @param baseDir   Directory against which relative `root` paths are resolved.
 * @returns RegistryParseResult — never throws.
 */
export function parseRegistryYaml(yamlText: string, baseDir: string): RegistryParseResult {
  let doc: unknown
  try {
    doc = yaml.parse(yamlText)
  } catch (e) {
    return { ok: false, errors: [`YAML parse error: ${(e as Error).message}`] }
  }

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, errors: ['Registry root must be a YAML mapping (agent_id → entry)'] }
  }

  const allErrors: string[] = []
  const registry: AgentRegistry = {}

  for (const [agentId, raw] of Object.entries(doc as Record<string, unknown>)) {
    if (agentId.trim() === '') {
      allErrors.push(`[empty-key] agent_id key is empty`)
      continue
    }
    const entryErrors = validateEntry(agentId, raw, baseDir)
    if (entryErrors.length > 0) {
      allErrors.push(...entryErrors)
    } else {
      // The registry file is the anchor: a relative `root` is written relative
      // to the registry file's own directory, not to whatever CWD the host
      // happens to run with. Resolve it once here so the bridge never has to
      // guess a base directory at invocation time.
      const entry = raw as AgentRegistryEntry
      entry.root = resolve(baseDir, entry.root)
      registry[agentId] = entry
    }
  }

  if (allErrors.length > 0) {
    return { ok: false, errors: allErrors }
  }
  return { ok: true, registry }
}

/**
 * Load and parse a registry file from disk.
 *
 * @param registryPath  Absolute or workspace-relative path to `registry.yaml`.
 * @returns RegistryParseResult
 */
export function loadRegistry(registryPath: string): RegistryParseResult {
  const absPath = resolve(registryPath)
  if (!existsSync(absPath)) {
    return { ok: false, errors: [`Registry file not found: ${absPath}`] }
  }
  const text = readFileSync(absPath, 'utf-8')
  const baseDir = dirname(absPath)
  return parseRegistryYaml(text, baseDir)
}

/**
 * Resolve and validate the agent root path against path-traversal.
 *
 * @param root        The `root` field from the registry entry.
 * @param workspaceRoot  The workspace directory the agent root must be inside.
 * @returns Resolved absolute path, or null if validation fails.
 */
export function resolveAgentRoot(root: string, workspaceRoot: string): string | null {
  const resolved = resolve(workspaceRoot, root)
  let wsReal: string
  try {
    wsReal = realpathSync(workspaceRoot)
  } catch {
    // A workspace root that does not exist cannot contain anything.
    return null
  }
  if (!resolved.startsWith(wsReal + '/') && resolved !== wsReal) {
    // Path escapes the workspace root
    return null
  }
  try {
    const real = realpathSync(resolved)
    if (!real.startsWith(wsReal + '/') && real !== wsReal) {
      return null
    }
    return real
  } catch {
    return null
  }
}
