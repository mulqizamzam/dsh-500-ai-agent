/**
 * Plugin entrypoint: dsh-500-ai-agent
 *
 * Cordis contract:
 *   - export const name = plugin identifier
 *   - export const inject = service names required from DSH context
 *   - export const Config = default configuration object
 *   - export function apply(ctx, config) = plugin lifecycle hook
 *
 * No default export — Loader.unwrapExports requires namespace-only exports.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { loadRegistry } from './registry.js'
import { evaluatePermission } from './permissions.js'
import type { PermissionRequest } from './permissions.js'
import { selectAgent } from './router.js'
import { runAgent } from './bridge.js'
import type { AgentRegistry, AgentRegistryEntry } from './types.js'

// ── Plugin identity ──────────────────────────────────────────────────────────
export const name = '500-ai-agent'
export const inject = ['sandbox', 'subprocess', 'tools']

// ── Plugin configuration ─────────────────────────────────────────────────────
export interface PluginConfig {
  registryPath: string
  workspaceRoot: string
  enableRouting: boolean
  logLevel: 'info' | 'warn' | 'error'
  /**
   * Default env vars forwarded to every agent invocation. Merged with the
   * per-call `context` (call-site wins) before permission evaluation.
   * Use this to avoid pasting OPENAI_API_KEY into every tool call.
   */
  defaultContext?: Record<string, string>
}

export const Config = Schema.object({
  registryPath: Schema.string().default('agents/registry.yaml'),
  workspaceRoot: Schema.string().default(''),
  enableRouting: Schema.boolean().default(true),
  logLevel: Schema.string().default('info'),
  defaultContext: Schema.dict(Schema.string()).default({}),
})

// ── Plugin state ─────────────────────────────────────────────────────────────
let _registry: AgentRegistry | null = null

function getRegistry(): AgentRegistry {
  if (_registry !== null) return _registry
  throw new Error('Agent registry not loaded — call ensureRegistry() first')
}

function ensureRegistry(config: PluginConfig): void {
  if (_registry !== null) return

  const workspaceRoot = config.workspaceRoot || process.cwd()
  const registryPath = config.registryPath
  const resolvedPath = registryPath.startsWith('/') ? registryPath : `${workspaceRoot}/${registryPath}`

  const result = loadRegistry(resolvedPath)
  if (!result.ok) {
    for (const err of result.errors) {
      console.warn(`[500-ai-agent] registry warning: ${err}`)
    }
  }

  _registry = result.ok ? result.registry : {}
  console.log(`[500-ai-agent] loaded ${Object.keys(_registry).length} agents from ${resolvedPath}`)
}

// ── Plugin apply ─────────────────────────────────────────────────────────────
/**
 * Plugin apply function.
 *
 * Cordis validates `config` against the `Config` schema BEFORE calling this,
 * so the four fields are already present with their defaults applied. The
 * signature keeps them optional only to satisfy the wider config type.
 *
 * @param ctx    DSH Context (provides services, logger, lifecycle hooks).
 * @param config Plugin configuration, already validated against `Config`.
 */
export function apply(ctx: Context, config: Partial<PluginConfig>): void {
  const fullConfig: PluginConfig = {
    registryPath: config.registryPath ?? 'agents/registry.yaml',
    workspaceRoot: config.workspaceRoot ?? '',
    enableRouting: config.enableRouting ?? true,
    logLevel: config.logLevel ?? 'info',
    defaultContext: config.defaultContext ?? {},
  }

  // ── Helper: resolve `env:VAR_NAME` placeholders in defaultContext ───────────
  function resolveDefaultContext(): Record<string, string> {
    const raw = fullConfig.defaultContext ?? {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.startsWith('env:')) {
        const envName = v.slice(4)
        const resolved = process.env[envName]
        if (resolved !== undefined) {
          out[k] = resolved
        }
      } else {
        out[k] = v
      }
    }
    return out
  }
  ensureRegistry(fullConfig)

  const log = (level: 'info' | 'warn' | 'error', msg: string) => {
    ctx.logger[level]?.(msg)
  }

  // ── run_agent tool ──────────────────────────────────────────────────────────
  const runAgentTool = defineTool({
    name: 'run_agent',
    description:
      'Invoke an agent from the 500-AI-Agents catalog. ' +
      'Runs in an isolated Python venv with permission-gated network/filesystem/secrets. ' +
      'Use capability-aware routing by providing a natural-language task.',
    parameters: {
      agent_id: {
        type: 'string',
        description: 'The agent_id from the registry (e.g., "pii-sanitization"). If omitted, capability routing selects the best match.',
      },
      task: {
        type: 'string',
        description: 'The task to execute. Shown to the agent and used for capability routing.',
        required: true,
      },
      context: {
        type: 'object',
        description: 'Optional key-value context for API keys, template variables, and env forwarding.',
        additionalProperties: true,
      },
      timeout_ms: {
        type: 'integer',
        description: 'Maximum execution time in milliseconds. Default: agent resources.timeout_ms.',
      },
      permissions_override: {
        type: 'object',
        description: 'Optional permission overrides: network (bool), shell (bool), filesystem (string), secrets (string[]). Denied if agent does not declare them.',
        additionalProperties: true,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => {
        const result = value as Record<string, unknown>
        const status = result.status ?? 'unknown'
        const meta = (result.metadata as Record<string, unknown>) ?? {}
        const dur = Number(meta.duration_ms ?? 0)
        const err = result.error as Record<string, unknown>
        let text = `[${status}] agent="${meta.agent_id}" duration=${dur}ms`
        if (err?.message) text += ` error="${String(err.message).slice(0, 100)}"`
        return [{ type: 'text', text }]
      },
    },
    async execute(args: Record<string, unknown>, _exec: ToolRunContext): Promise<JsonValue> {
      const agentIdOverride = args.agent_id as string | undefined
      const task = args.task as string
      const context = args.context as Record<string, unknown> | undefined
      const mergedContext = { ...resolveDefaultContext(), ...(context ?? {}) }
      const timeoutMs = Number(args.timeout_ms) || undefined
      const permOverride = args.permissions_override as Record<string, unknown> | undefined

      if (!task || task.trim() === '') {
        return makeError('INVALID_INPUT', 'task is required and must be non-empty')
      }

      const registry = getRegistry()
      let entry: AgentRegistryEntry
      let selectedAgentId: string

      // ── Route agent ───────────────────────────────────────────────────────
      if (agentIdOverride) {
        entry = registry[agentIdOverride]
        if (!entry) {
          return makeError('AGENT_NOT_FOUND', `agent_id "${agentIdOverride}" not in registry`)
        }
        selectedAgentId = agentIdOverride
      } else if (fullConfig.enableRouting) {
        const selected = selectAgent(registry, task)
        if (!selected) {
          return makeError('NO_ELIGIBLE_AGENT', 'no agent matches the request capabilities')
        }
        entry = selected.entry
        selectedAgentId = selected.id
      } else {
        return makeError('ROUTING_DISABLED', 'routing is disabled and no agent_id provided')
      }

      // ── Validate status ───────────────────────────────────────────────────
      if (entry.status === 'disabled' || entry.status === 'registered') {
        return makeError('AGENT_DISABLED', `agent "${selectedAgentId}" has status "${entry.status}" — not eligible`)
      }

      // ── Evaluate permissions ──────────────────────────────────────────────
      const permRequest: PermissionRequest = {
        network: permOverride?.network as boolean | undefined,
        shell: permOverride?.shell as boolean | undefined,
        filesystem: (permOverride?.filesystem as 'read' | 'readwrite' | null | undefined) ?? null,
        secrets: (permOverride?.secrets as string[] | undefined) ?? [],
      }
      const permissionResult = evaluatePermission(entry, permRequest)
      if (!permissionResult.allowed) {
        return makeError('PERMISSION_DENIED', `permission denied for: ${permissionResult.denied.join(', ')}`)
      }

      // ── Run the agent ─────────────────────────────────────────────────────
      const effectiveTimeout = timeoutMs ?? entry.resources.timeout_ms
      log('info', `[${selectedAgentId}] executing timeout=${effectiveTimeout}ms`)

      const result = await runAgent(
        entry,
        { agent_id: selectedAgentId, task, context: mergedContext, timeout_ms: effectiveTimeout },
        {
          subprocess: ctx.subprocess,
          // The host runs dsh-sandbox 0.2.0-rc.2, whose confine() is async,
          // while the published 0.1.x declarations this plugin compiles against
          // still type it synchronous. Wrapping the call in Promise.resolve
          // satisfies the bridge's async contract under both shapes: a promise
          // return passes through, a plain result gets wrapped.
          sandbox: ctx.sandbox ? {
            confine: (argv, policy) => Promise.resolve(ctx.sandbox!.confine(argv, policy)),
          } : undefined,
          logger: ctx.logger,
          workspaceRoot: fullConfig.workspaceRoot || process.cwd(),
        },
        permissionResult,
      )

      log('info', `[${selectedAgentId}] completed: ${result.status}`)
      return result as unknown as JsonValue
    },
  })

  ctx.tools.register(runAgentTool)
  log('info', '[500-ai-agent] tool "run_agent" registered')

  // ── list_agents tool ────────────────────────────────────────────────────────
  const listAgentsTool = defineTool({
    name: 'dsh500_list_agents',
    description: 'List all agents in the 500-AI-Agents registry with status and capabilities.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => {
        const agents = value as Array<Record<string, unknown>>
        const text = agents.length === 0
          ? 'No agents found'
          : `Found ${agents.length} agent(s):\n` +
              agents.map((a) => `  - ${a.agent_id} (${a.status}): ${(a.capabilities as string[] | undefined)?.join(', ')}`).join('\n')
        return [{ type: 'text', text }]
      },
    },
    async execute(_args: Record<string, unknown>): Promise<JsonValue> {
      const registry = getRegistry()
      return Object.entries(registry).map(([id, entry]) => ({
        agent_id: id,
        name: entry.name,
        status: entry.status,
        capabilities: entry.capabilities,
        runtime: { type: entry.runtime.type, version: entry.runtime.version },
        permissions: { network: entry.permissions.network, shell: entry.permissions.shell, secrets: entry.permissions.secrets },
      })) as unknown as JsonValue
    },
  })

  ctx.tools.register(listAgentsTool)
  log('info', '[500-ai-agent] tool "dsh500_list_agents" registered')
}

/** Helper to create a structured error result. */
function makeError(code: string, message: string): JsonValue {
  return {
    status: 'error',
    error: { code, message },
    metadata: {
      execution_id: '',
      agent_id: '',
      agent_version: '',
      started_at: 0,
      duration_ms: 0,
      status: 'error',
      exit_code: null,
      signal: null,
      tools_used: [],
    },
  }
}
