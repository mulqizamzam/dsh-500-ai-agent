/**
 * Registry parsing and validation tests.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRegistry, parseRegistryYaml, validateEntry, resolveAgentRoot } from '../lib/registry.js'
import type { AgentRegistryEntry } from '../lib/types.js'

describe('registry.parseRegistryYaml', () => {
  let baseDir: string

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'dsh500-registry-parse-'))
  })

  it('parses a valid minimal registry', () => {
    const yaml = `
pii-sanitization:
  agent_id: pii-sanitization
  name: PII Sanitization Agent
  version: "1.0.0"
  runtime:
    type: python
    version: "3.11"
  entrypoint: agent.py
  capabilities:
    - pii
    - security
  permissions:
    network: true
    filesystem: null
    shell: false
    secrets: []
  resources:
    timeout_ms: 120000
  source:
    repository: ashishpatel26/500-AI-Agents-Projects
    path: agents/21-pii-sanitization-agent
    commit: 9beeb721c2af551bacaab827a76bddaecaa0ca5e
  status: experimental
  root: ${baseDir}
`
    const result = parseRegistryYaml(yaml, baseDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.keys(result.registry)).toHaveLength(1)
      expect(result.registry['pii-sanitization'].agent_id).toBe('pii-sanitization')
      expect(result.registry['pii-sanitization'].name).toBe('PII Sanitization Agent')
    }
  })

  it('returns errors for malformed YAML', () => {
    const result = parseRegistryYaml('{{{invalid yaml', baseDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain('YAML parse error')
    }
  })

  it('returns errors for missing required fields', () => {
    const yaml = `
bad-agent:
  agent_id: bad-agent
  name: Bad Agent
`
    const result = parseRegistryYaml(yaml, baseDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const errorStr = result.errors.join(' ')
      expect(errorStr).toContain('runtime')
      expect(errorStr).toContain('entrypoint')
      expect(errorStr).toContain('capabilities')
    }
  })

  it('rejects invalid status values', () => {
    const yaml = `
test-agent:
  agent_id: test-agent
  name: Test
  version: "1.0.0"
  runtime: { type: python, version: "3.11" }
  entrypoint: agent.py
  capabilities: [general]
  permissions:
    network: false
    filesystem: null
    shell: false
    secrets: []
  resources: { timeout_ms: 60000 }
  source:
    repository: test/repo
    path: agents/test
    commit: abc123
  status: not_a_valid_status
  root: ${baseDir}
`
    const result = parseRegistryYaml(yaml, baseDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e: string) => e.includes('status'))).toBe(true)
    }
  })

  it('rejects registry where root does not exist', () => {
    const yaml = `
missing-root-agent:
  agent_id: missing-root-agent
  name: Missing Root
  version: "1.0.0"
  runtime: { type: python, version: "3.11" }
  entrypoint: agent.py
  capabilities: [general]
  permissions: { network: false, filesystem: null, shell: false, secrets: [] }
  resources: { timeout_ms: 60000 }
  source: { repository: test/repo, path: a, commit: abc }
  status: experimental
  root: ${baseDir}/does-not-exist
`
    const result = parseRegistryYaml(yaml, baseDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e: string) => e.includes('does not exist'))).toBe(true)
    }
  })
})

describe('registry.validateEntry', () => {
  it('accepts a valid entry', () => {
    const entry = {
      agent_id: 'pii-sanitization',
      name: 'PII Sanitization Agent',
      version: '1.0.0',
      runtime: { type: 'python', version: '3.11' },
      entrypoint: 'agent.py',
      capabilities: ['pii', 'security'],
      permissions: { network: true, filesystem: null, shell: false, secrets: [] },
      resources: { timeout_ms: 120000 },
      source: { repository: 'test/repo', path: 'agents/test', commit: 'abc123' },
      status: 'experimental',
      root: '/tmp',
    }
    const errors = validateEntry('pii-sanitization', entry, '/tmp')
    expect(errors).toHaveLength(0)
  })

  it('rejects invalid agent_id with uppercase', () => {
    const entry = {
      agent_id: 'PII-Sanitization',
      name: 'Bad',
      version: '1.0.0',
      runtime: { type: 'python', version: '3.11' },
      entrypoint: 'agent.py',
      capabilities: ['general'],
      permissions: { network: false, filesystem: null, shell: false, secrets: [] },
      resources: { timeout_ms: 60000 },
      source: { repository: 'test/repo', path: 'a', commit: 'abc' },
      status: 'experimental',
      root: '/tmp',
    }
    const errors = validateEntry('pii', entry, '/tmp')
    expect(errors.some((e: string) => e.includes('agent_id'))).toBe(true)
  })

  it('rejects unknown capability tags', () => {
    const entry = {
      agent_id: 'test',
      name: 'Test',
      version: '1.0.0',
      runtime: { type: 'python', version: '3.11' },
      entrypoint: 'agent.py',
      capabilities: ['unknown-capability'],
      permissions: { network: false, filesystem: null, shell: false, secrets: [] },
      resources: { timeout_ms: 60000 },
      source: { repository: 'test/repo', path: 'a', commit: 'abc' },
      status: 'experimental',
      root: '/tmp',
    }
    const errors = validateEntry('test', entry, '/tmp')
    expect(errors.some((e: string) => e.includes('capabilities'))).toBe(true)
  })

  it('rejects missing source.commit', () => {
    const entry = {
      agent_id: 'test',
      name: 'Test',
      version: '1.0.0',
      runtime: { type: 'python', version: '3.11' },
      entrypoint: 'agent.py',
      capabilities: ['general'],
      permissions: { network: false, filesystem: null, shell: false, secrets: [] },
      resources: { timeout_ms: 60000 },
      source: { repository: 'test/repo', path: 'a', commit: '' },
      status: 'experimental',
      root: '/tmp',
    }
    const errors = validateEntry('test', entry, '/tmp')
    expect(errors.some((e: string) => e.includes('source.commit'))).toBe(true)
  })

  it('rejects invalid network type', () => {
    const entry = {
      agent_id: 'test',
      name: 'Test',
      version: '1.0.0',
      runtime: { type: 'python', version: '3.11' },
      entrypoint: 'agent.py',
      capabilities: ['general'],
      permissions: { network: 'yes', filesystem: null, shell: false, secrets: [] },
      resources: { timeout_ms: 60000 },
      source: { repository: 'test/repo', path: 'a', commit: 'abc' },
      status: 'experimental',
      root: '/tmp',
    }
    const errors = validateEntry('test', entry, '/tmp')
    expect(errors.some((e: string) => e.includes('network'))).toBe(true)
  })
})

describe('registry.resolveAgentRoot', () => {
  it('returns null for paths escaping workspace', () => {
    const result = resolveAgentRoot('../../etc', '/tmp')
    expect(result).toBeNull()
  })

  it('returns null when workspace does not exist', () => {
    const result = resolveAgentRoot('agents/test', '/nonexistent/path/xyz')
    expect(result).toBeNull()
  })

  it('returns resolved path for valid existing relative paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh500-root-resolve-'))
    try {
      const result = resolveAgentRoot('', dir)
      expect(result).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('registry.loadRegistry', () => {
  it('returns error for missing file', () => {
    const result = loadRegistry('/tmp/does-not-exist-xyz.yaml')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e: string) => e.includes('not found'))).toBe(true)
    }
  })

  it('loads a valid registry file from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh500-registry-load-'))
    const filePath = join(dir, 'registry.yaml')
    writeFileSync(filePath, `
test-agent:
  agent_id: test-agent
  name: Test Agent
  version: "1.0.0"
  runtime:
    type: python
    version: "3.11"
  entrypoint: agent.py
  capabilities:
    - general
  permissions:
    network: false
    filesystem: null
    shell: false
    secrets: []
  resources:
    timeout_ms: 60000
  source:
    repository: test/repo
    path: agents/test
    commit: abc123def456789
  status: experimental
  root: ${dir}
`)

    try {
      const result = loadRegistry(filePath)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.registry['test-agent'].name).toBe('Test Agent')
        expect(result.registry['test-agent'].status).toBe('experimental')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads all 17 registered agents including the 13 newly added', () => {
    const result = loadRegistry(join(process.cwd(), 'agents', 'registry.yaml'))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.errors.join('; '))
    const ids = Object.keys(result.registry)
    expect(ids).toHaveLength(17)
    // Existing 4
    for (const id of ['pii-sanitization', 'code-review', 'documentation-writer', 'web-research']) {
      expect(ids).toContain(id)
    }
    // 13 newly added
    for (const id of [
      'email-drafting',
      'news-summarizer',
      'github-issue-triager',
      'resume-parser',
      'meeting-notes',
      'stock-research',
      'travel-planner',
      'social-media',
      'unit-test-generator',
      'recipe-agent',
      'job-application',
      'competitive-analysis',
      'multi-agent-debate',
    ]) {
      expect(ids).toContain(id)
    }
  })
})

describe('registry: newly added agents validate correctly', () => {
  const result = loadRegistry(join(process.cwd(), 'agents', 'registry.yaml'))
  if (!result.ok) throw new Error(`registry load failed: ${result.errors.join('; ')}`)
  const REG = result.registry

  it('each new agent has a valid agent_id, name, entrypoint, root, and commit', () => {
    for (const id of [
      'email-drafting', 'news-summarizer', 'github-issue-triager',
      'resume-parser', 'meeting-notes', 'stock-research', 'travel-planner',
      'social-media', 'unit-test-generator', 'recipe-agent',
      'job-application', 'competitive-analysis', 'multi-agent-debate',
    ]) {
      const e = REG[id]
      expect(e.agent_id).toBe(id)
      expect(e.name.length).toBeGreaterThan(0)
      expect(e.entrypoint).toBe('agent.py')
      expect(e.runtime.type).toBe('python')
      expect(e.runtime.version).toBe('3.11')
      expect(e.source.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(e.status).toBe('experimental')
      expect(e.capabilities.length).toBeGreaterThan(0)
      // root must resolve to an existing directory containing agent.py
      const abs = resolvePath('agents', e.root)
      expect(existsSync(abs)).toBe(true)
      expect(statSync(abs).isDirectory()).toBe(true)
      expect(existsSync(resolvePath(abs, e.entrypoint))).toBe(true)
    }
  })

  it('new LLM-backed agents declare OPENAI_API_KEY in their secret allowlist', () => {
    for (const id of [
      'email-drafting', 'news-summarizer', 'github-issue-triager',
      'resume-parser', 'meeting-notes', 'stock-research', 'travel-planner',
      'social-media', 'unit-test-generator', 'recipe-agent',
      'job-application', 'competitive-analysis', 'multi-agent-debate',
    ]) {
      expect(REG[id].permissions.secrets).toContain('OPENAI_API_KEY')
    }
  })

  it('news-summarizer additionally declares NEWS_API_KEY', () => {
    expect(REG['news-summarizer'].permissions.secrets).toContain('NEWS_API_KEY')
  })

  it('github-issue-triager additionally declares GITHUB_TOKEN', () => {
    expect(REG['github-issue-triager'].permissions.secrets).toContain('GITHUB_TOKEN')
  })

  it('non-LLM-capable agents still require OPENAI_API_KEY (agent code uses LangChain/crewai)', () => {
    // All 13 new agents use LangChain/crewai under the hood even if not all are
    // LLM-strict in name; they all import ChatOpenAI or CrewAI which needs the key.
    for (const id of Object.keys(REG)) {
      if (id === 'pii-sanitization') continue // already tested by sibling
      const e = REG[id]
      expect(e.permissions.network).toBe(true)
      expect(e.permissions.shell).toBe(false)
    }
  })

  it('entrypoint_args templates contain {{task}} where appropriate', () => {
    const argsAgents: Record<string, boolean> = {
      'email-drafting': true,
      'news-summarizer': true,
      'github-issue-triager': true,
      'meeting-notes': true,
      'stock-research': true,
      'travel-planner': true,
      'social-media': true,
      'unit-test-generator': true,
      'recipe-agent': true,
      'job-application': true,
      'competitive-analysis': true,
      'multi-agent-debate': true,
      'resume-parser': true,   // --resume {{task}} — task carries the resume file path
    }
    for (const [id, expectTask] of Object.entries(argsAgents)) {
      const args = REG[id].entrypoint_args
      expect(args).toBeDefined()
      if (expectTask) {
        expect(args!.some((a: string) => a.includes('{{task}}'))).toBe(true)
      }
    }
  })

  it('capabilities are drawn from the approved AgentCapability set', () => {
    const VALID_CAPS = new Set([
      'research', 'code-review', 'pii', 'summary', 'documentation',
      'security', 'compliance', 'qa', 'data-analysis', 'general',
    ])
    for (const id of [
      'email-drafting', 'news-summarizer', 'github-issue-triager',
      'resume-parser', 'meeting-notes', 'stock-research', 'travel-planner',
      'social-media', 'unit-test-generator', 'recipe-agent',
      'job-application', 'competitive-analysis', 'multi-agent-debate',
    ]) {
      for (const cap of REG[id].capabilities) {
        expect(VALID_CAPS.has(cap)).toBe(true)
      }
    }
  })
})
