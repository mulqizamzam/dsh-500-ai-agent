/**
 * Capability router: maps a user request to one eligible agent from the registry.
 *
 * Routing is metadata-driven, never folder-number-driven:
 *   1. Detect capability keywords in the request text.
 *   2. Keep agents whose registered `capabilities` overlap the detected set.
 *   3. Drop agents whose `status` is not execution-eligible.
 *   4. Prefer the highest match count, then the most mature status, then id.
 */

import type { AgentRegistry, AgentCapability } from './types.js'

/**
 * Keyword → capability mapping.
 * Keys are SEARCH PHRASES (lowercase). Values are registry capability tags.
 */
// Keywords that trigger capability detection. Values MUST be valid AgentCapability tags.
const CAPABILITY_KEYWORDS: Record<string, AgentCapability[]> = {
  research: ['research'],
  pii: ['pii'],
  sanitize: ['pii'],
  scrub: ['pii'],
  anonymize: ['pii'],
  'data privacy': ['pii'],
  security: ['security'],
  audit: ['security'],
  compliance: ['compliance'],
  'code-review': ['code-review'],
  'code review': ['code-review'],
  qa: ['qa'],
  'data-analysis': ['data-analysis'],
  'data analysis': ['data-analysis'],
  documentation: ['documentation'],
  summary: ['summary'],
}

/** Statuses an agent may hold to be eligible for execution. */
const EXECUTABLE_STATUSES = new Set(['experimental', 'validated', 'production'])

/** Status preference order, strongest first. */
const STATUS_RANK: Record<string, number> = {
  production: 0,
  validated: 1,
  experimental: 2,
}

/**
 * Detect capabilities from a human-readable request string.
 *
 * Matching is case-insensitive substring matching on the registered keyword
 * phrases. A request that matches nothing yields an empty set — the caller
 * must treat that as "no eligible agent", never as "fall back to agent #1".
 */
export function detectCapabilities(request: string): Set<AgentCapability> {
  const lowered = request.toLowerCase()
  const matched = new Set<AgentCapability>()

  for (const [phrase, caps] of Object.entries(CAPABILITY_KEYWORDS)) {
    if (lowered.includes(phrase)) {
      for (const cap of caps) {
        matched.add(cap)
      }
    }
  }

  return matched
}

/**
 * Find every agent whose registered capabilities intersect the detected set.
 *
 * @returns Agent ids ordered by match count desc, then id asc for stability.
 */
export function findEligibleAgents(
  registry: AgentRegistry,
  capabilities: Set<AgentCapability>,
): string[] {
  if (capabilities.size === 0) {
    return []
  }

  const eligible: { id: string; score: number }[] = []

  for (const [id, entry] of Object.entries(registry)) {
    if (!EXECUTABLE_STATUSES.has(entry.status)) {
      continue
    }
    const score = entry.capabilities.filter((cap) => capabilities.has(cap)).length
    if (score > 0) {
      eligible.push({ id, score })
    }
  }

  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.id.localeCompare(b.id)
  })

  return eligible.map((entry) => entry.id)
}

/**
 * Select the best agent for a request.
 *
 * @returns The chosen agent, or null when nothing matches.
 */
export function selectAgent(
  registry: AgentRegistry,
  request: string,
): { id: string; entry: AgentRegistry['string'] } | null {
  const capabilities = detectCapabilities(request)
  const eligible = findEligibleAgents(registry, capabilities)

  if (eligible.length === 0) {
    return null
  }

  const scored = eligible
    .map((id) => ({ id, rank: STATUS_RANK[registry[id].status] ?? 99 }))
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))

  const chosen = scored[0]
  return { id: chosen.id, entry: registry[chosen.id] }
}