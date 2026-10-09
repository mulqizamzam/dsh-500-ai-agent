/**
 * Regression: a caller that does NOT name a network preference must inherit
 * the agent's own declaration. Without this, every run_agent call that omits
 * `network` (i.e. all of them — the tool never sends it) evaluates to
 * granted.network=false, the bridge injects --unshare-net, and any agent that
 * needs an API call dies with APIConnectionError.
 *
 * Mirrors how `secrets` already falls back to the agent's declaration when
 * the request names none.
 */
import { describe, it, expect } from 'vitest'
import { evaluatePermission } from '../src/permissions.js'
import { loadRegistry } from '../src/registry.js'
import type { AgentRegistryEntry } from '../src/types.js'

const REG = (loadRegistry('./agents/registry.yaml').ok
  ? (loadRegistry('./agents/registry.yaml') as { ok: true; registry: Record<string, AgentRegistryEntry> }).registry
  : {}) as Record<string, AgentRegistryEntry>

describe('network permission fallback', () => {
  it('agent declaring network:true is granted network when the request is silent', () => {
    const entry = REG['documentation-writer']
    expect(entry.permissions.network).toBe(true)
    const res = evaluatePermission(entry, { network: undefined })
    expect(res.granted.network).toBe(true)
  })

  it('request.network=false still wins over the agent declaration', () => {
    const entry = REG['documentation-writer']
    const res = evaluatePermission(entry, { network: false })
    expect(res.granted.network).toBe(false)
  })

  it('agent declaring network:false never gets network', () => {
    const entry: AgentRegistryEntry = {
      ...REG['pii-sanitization'],
      permissions: { ...REG['pii-sanitization'].permissions, network: false },
    }
    const res = evaluatePermission(entry, { network: undefined })
    expect(res.granted.network).toBe(false)
  })
})
