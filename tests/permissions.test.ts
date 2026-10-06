/**
 * Permission evaluation tests (default deny).
 */

import { describe, it, expect } from 'vitest'
import { evaluatePermission } from '../lib/permissions.js'
import type { AgentRegistryEntry } from '../lib/types.js'

function makeAgent(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    agent_id: 'test-agent',
    name: 'Test Agent',
    version: '1.0.0',
    runtime: { type: 'python', version: '3.11' },
    entrypoint: 'agent.py',
    capabilities: ['general'],
    permissions: { network: false, filesystem: null, shell: false, secrets: [] },
    resources: { timeout_ms: 60000 },
    source: { repository: 'test/repo', path: 'agents/test', commit: 'abc123def456' },
    status: 'experimental',
    root: '/tmp',
    ...overrides,
  }
}

describe('permissions.evaluatePermission', () => {
  it('denies network when agent does not grant it', () => {
    const agent = makeAgent()
    const result = evaluatePermission(agent, { network: true })
    expect(result.allowed).toBe(false)
    expect(result.denied).toContain('network')
    expect(result.granted.network).toBe(false)
  })

  it('grants network when agent declares it', () => {
    const agent = makeAgent({
      permissions: { network: true, filesystem: null, shell: false, secrets: [] },
    })
    const result = evaluatePermission(agent, { network: true })
    expect(result.allowed).toBe(true)
    expect(result.granted.network).toBe(true)
  })

  it('denies shell when agent does not grant it', () => {
    const agent = makeAgent()
    const result = evaluatePermission(agent, { shell: true })
    expect(result.allowed).toBe(false)
    expect(result.denied).toContain('shell')
  })

  it('grants shell when agent declares it', () => {
    const agent = makeAgent({
      permissions: { network: false, filesystem: null, shell: true, secrets: [] },
    })
    const result = evaluatePermission(agent, { shell: true })
    expect(result.allowed).toBe(true)
    expect(result.granted.shell).toBe(true)
  })

  it('denies filesystem when agent has none', () => {
    const agent = makeAgent()
    const result = evaluatePermission(agent, {
      filesystem: 'read',
      filesystemPaths: ['/tmp'],
    })
    expect(result.allowed).toBe(false)
    expect(result.denied).toContain('filesystem')
  })

  it('grants filesystem read when agent declares it', () => {
    const agent = makeAgent({
      permissions: {
        network: false,
        filesystem: { mode: 'read', paths: ['/tmp/input'] },
        shell: false,
        secrets: [],
      },
    })
    const result = evaluatePermission(agent, {
      filesystem: 'read',
      filesystemPaths: ['/tmp/input'],
    })
    expect(result.allowed).toBe(true)
    expect(result.granted.filesystem?.mode).toBe('read')
  })

  it('denies readwrite when agent only grants read', () => {
    const agent = makeAgent({
      permissions: {
        network: false,
        filesystem: { mode: 'read', paths: ['/tmp/input'] },
        shell: false,
        secrets: [],
      },
    })
    const result = evaluatePermission(agent, {
      filesystem: 'readwrite',
      filesystemPaths: ['/tmp/input'],
    })
    expect(result.allowed).toBe(false)
    expect(result.denied).toContain('filesystem')
  })

  it('denies a filesystem path outside the agent grant', () => {
    const agent = makeAgent({
      permissions: {
        network: false,
        filesystem: { mode: 'read', paths: ['/tmp/input'] },
        shell: false,
        secrets: [],
      },
    })
    const result = evaluatePermission(agent, {
      filesystem: 'read',
      filesystemPaths: ['/etc/passwd'],
    })
    expect(result.allowed).toBe(false)
    expect(result.denied).toContain('filesystem')
  })

  it('denies secrets not declared by agent', () => {
    const agent = makeAgent({
      permissions: { network: false, filesystem: null, shell: false, secrets: ['API_KEY'] },
    })
    const result = evaluatePermission(agent, { secrets: ['MISSING_KEY'] })
    expect(result.allowed).toBe(false)
    expect(result.denied).toContain('secrets')
  })

  it('grants a subset of declared secrets', () => {
    const agent = makeAgent({
      permissions: { network: false, filesystem: null, shell: false, secrets: ['API_KEY', 'DB_HOST'] },
    })
    const result = evaluatePermission(agent, { secrets: ['API_KEY'] })
    expect(result.allowed).toBe(true)
    expect(result.granted.secrets).toEqual(['API_KEY'])
  })

  it('allows empty permission request under default deny', () => {
    const agent = makeAgent()
    const result = evaluatePermission(agent, {})
    expect(result.allowed).toBe(true)
    expect(result.granted.network).toBe(false)
    expect(result.granted.shell).toBe(false)
    expect(result.granted.secrets).toHaveLength(0)
  })

  it('denies multiple simultaneous ungranted requests', () => {
    const agent = makeAgent()
    const result = evaluatePermission(agent, { network: true, shell: true })
    expect(result.allowed).toBe(false)
    expect(result.denied).toContain('network')
    expect(result.denied).toContain('shell')
  })
})
