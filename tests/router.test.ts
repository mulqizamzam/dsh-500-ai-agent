/**
 * Router capability detection and agent selection tests.
 */

import { describe, it, expect } from 'vitest'
import { detectCapabilities, findEligibleAgents, selectAgent } from '../lib/router.js'
import type { AgentRegistry, AgentRegistryEntry } from '../lib/types.js'

function makeAgent(id: string, caps: string[], status: AgentRegistryEntry['status']): AgentRegistryEntry {
  return {
    agent_id: id,
    name: id,
    version: '1.0.0',
    runtime: { type: 'python', version: '3.11' },
    entrypoint: 'agent.py',
    capabilities: caps as AgentRegistryEntry['capabilities'],
    permissions: { network: false, filesystem: null, shell: false, secrets: [] },
    resources: { timeout_ms: 60000 },
    source: { repository: 'test/repo', path: `agents/${id}`, commit: 'abc123def456' },
    status,
    root: '/tmp',
  }
}

describe('router.detectCapabilities', () => {
  it('detects research capability from English text', () => {
    const caps = detectCapabilities('I need to research the EV market in Indonesia')
    expect(caps.has('research')).toBe(true)
  })

  it('detects pii capability', () => {
    const caps = detectCapabilities('sanitize this PII data before sending to LLM')
    expect(caps.has('pii')).toBe(true)
  })

  it('detects pii capability from "sanitize" without explicit PII mention', () => {
    const caps = detectCapabilities('sanitize this text: john@example.com')
    expect(caps.has('pii')).toBe(true)
  })

  it('detects pii capability from "scrub" without explicit PII mention', () => {
    const caps = detectCapabilities('scrub the emails from this log')
    expect(caps.has('pii')).toBe(true)
  })

  it('detects pii capability from "data privacy" phrase', () => {
    const caps = detectCapabilities('check data privacy compliance of this dataset')
    expect(caps.has('pii')).toBe(true)
  })

  it('detects code-review capability from "code review" phrase (space separated)', () => {
    const caps = detectCapabilities('please do a code review of this diff')
    expect(caps.has('code-review')).toBe(true)
  })

  it('detects code-review capability', () => {
    const caps = detectCapabilities('please code-review this PR')
    expect(caps.has('code-review')).toBe(true)
  })

  it('detects security capability', () => {
    const caps = detectCapabilities('run a security audit on the repo')
    expect(caps.has('security')).toBe(true)
  })

  it('detects documentation capability', () => {
    const caps = detectCapabilities('write documentation for this module')
    expect(caps.has('documentation')).toBe(true)
  })

  it('returns empty set for unrelated text', () => {
    const caps = detectCapabilities('hello world this is unrelated')
    expect(caps.size).toBe(0)
  })

  it('handles empty string', () => {
    const caps = detectCapabilities('')
    expect(caps.size).toBe(0)
  })

  it('detects data-analysis capability', () => {
    const caps = detectCapabilities('run data-analysis on this CSV')
    expect(caps.has('data-analysis')).toBe(true)
  })
})

describe('router.findEligibleAgents', () => {
  const registry: AgentRegistry = {
    'pii-sanitization': makeAgent('pii-sanitization', ['pii', 'security'], 'experimental'),
    'code-review': makeAgent('code-review', ['code-review'], 'validated'),
    'disabled-agent': makeAgent('disabled-agent', ['pii'], 'disabled'),
    'registered-only': makeAgent('registered-only', ['pii'], 'registered'),
  }

  it('returns eligible agents for pii capability', () => {
    const eligible = findEligibleAgents(registry, new Set(['pii']))
    expect(eligible).toContain('pii-sanitization')
    expect(eligible).not.toContain('disabled-agent')
    expect(eligible).not.toContain('registered-only')
  })

  it('excludes disabled and registered agents', () => {
    const eligible = findEligibleAgents(registry, new Set(['pii', 'code-review']))
    expect(eligible).not.toContain('disabled-agent')
    expect(eligible).not.toContain('registered-only')
  })

  it('returns empty for no matching capabilities', () => {
    const eligible = findEligibleAgents(registry, new Set(['cooking'] as never))
    expect(eligible).toHaveLength(0)
  })

  it('returns empty when capabilities set is empty', () => {
    const eligible = findEligibleAgents(registry, new Set())
    expect(eligible).toHaveLength(0)
  })
})

describe('router.selectAgent', () => {
  const registry: AgentRegistry = {
    'pii-experimental': makeAgent('pii-experimental', ['pii', 'security'], 'experimental'),
    'pii-validated': makeAgent('pii-validated', ['pii', 'security'], 'validated'),
  }

  it('selects the agent matching the task capability', () => {
    const selected = selectAgent(registry, 'sanitize PII data from this text')
    expect(selected).not.toBeNull()
    if (selected) {
      expect(selected.id).toBe('pii-validated')
    }
  })

  it('prefers validated over experimental for same capability', () => {
    const selected = selectAgent(registry, 'sanitize PII data')
    expect(selected).not.toBeNull()
    if (selected) {
      expect(selected.id).toBe('pii-validated')
      expect(selected.entry.status).toBe('validated')
    }
  })

  it('returns null when no agent matches the task', () => {
    const selected = selectAgent(registry, 'cook a dinner recipe')
    expect(selected).toBeNull()
  })

  it('falls back to experimental when no validated/production exists', () => {
    const onlyExp: AgentRegistry = {
      'pii-only-exp': makeAgent('pii-only-exp', ['pii'], 'experimental'),
    }
    const selected = selectAgent(onlyExp, 'sanitize PII')
    expect(selected).not.toBeNull()
    if (selected) {
      expect(selected.id).toBe('pii-only-exp')
    }
  })
})

describe('router.selectAgent — capability match count is the PRIMARY sort key', () => {
  // The module contract is: "Prefer the highest match count, then the most
  // mature status, then id." Match count outranks BOTH of the tiebreakers, so
  // these cases fix the score ahead of status and ahead of id order.
  it('picks the higher match count when the loser has a more mature status', () => {
    const registry: AgentRegistry = {
      'broad-experimental': makeAgent('broad-experimental', ['pii', 'security', 'compliance'], 'experimental'),
      'narrow-production': makeAgent('narrow-production', ['security'], 'production'),
    }
    const selected = selectAgent(registry, 'sanitize pii and audit security compliance')
    expect(selected).not.toBeNull()
    if (selected) expect(selected.id).toBe('broad-experimental')
  })

  it('picks the higher match count even when the loser sorts first by id', () => {
    // 'aaa' would win a pure id comparison; it must not win on that alone.
    const registry: AgentRegistry = {
      'aaa-low-match': makeAgent('aaa-low-match', ['security'], 'experimental'),
      'zzz-high-match': makeAgent('zzz-high-match', ['pii', 'security', 'compliance'], 'experimental'),
    }
    const selected = selectAgent(registry, 'sanitize pii and audit security compliance')
    expect(selected).not.toBeNull()
    if (selected) expect(selected.id).toBe('zzz-high-match')
  })

  it('agrees with findEligibleAgents on the top pick when both have equal status', () => {
    // Precondition matters: findEligibleAgents has no maturity tiebreak, so on
    // an equal-status registry the two must agree. When statuses differ they
    // are allowed to diverge — selectAgent applies maturity, the list does not.
    const registry: AgentRegistry = {
      'pii-sanitization': makeAgent('pii-sanitization', ['pii', 'security', 'compliance', 'general'], 'experimental'),
      'code-review': makeAgent('code-review', ['code-review', 'security', 'general'], 'experimental'),
    }
    const request = 'sanitize pii and audit security compliance in this log'
    const expectedTop = findEligibleAgents(registry, detectCapabilities(request))[0]
    const selected = selectAgent(registry, request)
    expect(selected).not.toBeNull()
    if (selected) expect(selected.id).toBe(expectedTop)
  })

  it('still uses status maturity as the tiebreak when the match count is equal', () => {
    // Guard against over-correcting into a score-only sort: the documented
    // tiebreak chain is score, then status, then id.
    const registry: AgentRegistry = {
      'pii-experimental': makeAgent('pii-experimental', ['pii', 'security'], 'experimental'),
      'pii-validated': makeAgent('pii-validated', ['pii', 'security'], 'validated'),
    }
    const selected = selectAgent(registry, 'sanitize PII data')
    expect(selected).not.toBeNull()
    if (selected) {
      expect(selected.id).toBe('pii-validated')
      expect(selected.entry.status).toBe('validated')
    }
  })

  it('still falls back to id order when score and status both tie', () => {
    const registry: AgentRegistry = {
      'alpha-agent': makeAgent('alpha-agent', ['pii'], 'experimental'),
      'beta-agent': makeAgent('beta-agent', ['pii'], 'experimental'),
    }
    const selected = selectAgent(registry, 'sanitize pii')
    expect(selected).not.toBeNull()
    if (selected) expect(selected.id).toBe('alpha-agent')
  })
})

describe('router.detectCapabilities — keywords backing the newly added agents', () => {
  it('detects qa capability (unit-test-generator)', () => {
    const caps = detectCapabilities('run the qa suite for this module')
    expect(caps.has('qa')).toBe(true)
  })

  it('detects summary capability from the word "summary" (news-summarizer, meeting-notes)', () => {
    const caps = detectCapabilities('give me a summary of today news')
    expect(caps.has('summary')).toBe(true)
  })

  it('does NOT claim summary from "summarize" (keyword is the literal phrase)', () => {
    const caps = detectCapabilities('summarize this article')
    expect(caps.has('summary')).toBe(false)
  })

  it('detects research capability (stock-research, competitive-analysis, multi-agent-debate)', () => {
    const caps = detectCapabilities('please research the competitive landscape')
    expect(caps.has('research')).toBe(true)
  })

  it('detects data-analysis capability (resume-parser, stock-research)', () => {
    const caps = detectCapabilities('run data analysis on these resumes')
    expect(caps.has('data-analysis')).toBe(true)
  })

  it('detects documentation capability (email-drafting, social-media, job-application)', () => {
    const caps = detectCapabilities('draft documentation for this launch')
    expect(caps.has('documentation')).toBe(true)
  })

  it('detects code-review capability (github-issue-triager, unit-test-generator)', () => {
    const caps = detectCapabilities('triage this code review request')
    expect(caps.has('code-review')).toBe(true)
  })
})

describe('router.findEligibleAgents — newly registered agents are routable', () => {
  const registry: AgentRegistry = {
    'news-summarizer': makeAgent('news-summarizer', ['summary', 'research', 'general'], 'experimental'),
    'meeting-notes': makeAgent('meeting-notes', ['documentation', 'summary', 'general'], 'experimental'),
    'unit-test-generator': makeAgent('unit-test-generator', ['code-review', 'qa', 'general'], 'experimental'),
    'github-issue-triager': makeAgent('github-issue-triager', ['code-review', 'general'], 'experimental'),
    'email-drafting': makeAgent('email-drafting', ['documentation', 'general'], 'experimental'),
    'stock-research': makeAgent('stock-research', ['research', 'data-analysis', 'general'], 'experimental'),
    'resume-parser': makeAgent('resume-parser', ['data-analysis', 'general'], 'experimental'),
    'competitive-analysis': makeAgent('competitive-analysis', ['research', 'data-analysis', 'general'], 'experimental'),
    'social-media': makeAgent('social-media', ['documentation', 'general'], 'experimental'),
    'job-application': makeAgent('job-application', ['documentation', 'general'], 'experimental'),
    'travel-planner': makeAgent('travel-planner', ['general', 'research'], 'experimental'),
    'recipe-agent': makeAgent('recipe-agent', ['general'], 'experimental'),
    'multi-agent-debate': makeAgent('multi-agent-debate', ['general', 'research'], 'experimental'),
    'disabled-new': makeAgent('disabled-new', ['summary'], 'disabled'),
  }

  it('routes a summary request to summary-capable new agents only', () => {
    const caps = detectCapabilities('i need a summary of this meeting')
    const eligible = findEligibleAgents(registry, caps)
    expect(eligible).toContain('news-summarizer')
    expect(eligible).toContain('meeting-notes')
    expect(eligible).not.toContain('disabled-new')
    expect(eligible).not.toContain('recipe-agent')
  })

  it('routes a qa request to unit-test-generator', () => {
    const caps = detectCapabilities('add qa coverage')
    const eligible = findEligibleAgents(registry, caps)
    expect(eligible).toEqual(['unit-test-generator'])
  })

  it('routes a research request to research-capable new agents', () => {
    const caps = detectCapabilities('research the market for me')
    const eligible = findEligibleAgents(registry, caps)
    expect(eligible).toEqual(
      expect.arrayContaining(['news-summarizer', 'stock-research', 'competitive-analysis', 'travel-planner', 'multi-agent-debate']),
    )
    expect(eligible).not.toContain('recipe-agent')
  })

  it('routes a data-analysis request to resume-parser and stock-research', () => {
    const caps = detectCapabilities('do data analysis on this')
    const eligible = findEligibleAgents(registry, caps)
    expect(eligible).toEqual(expect.arrayContaining(['resume-parser', 'stock-research', 'competitive-analysis']))
  })

  it('routes a documentation request to documentation-capable new agents', () => {
    const caps = detectCapabilities('write documentation for this feature')
    const eligible = findEligibleAgents(registry, caps)
    expect(eligible).toEqual(
      expect.arrayContaining(['email-drafting', 'meeting-notes', 'social-media', 'job-application']),
    )
  })

  it('routes a code-review request to github-issue-triager and unit-test-generator', () => {
    const caps = detectCapabilities('please do a code review')
    const eligible = findEligibleAgents(registry, caps)
    expect(eligible).toEqual(expect.arrayContaining(['github-issue-triager', 'unit-test-generator']))
  })

  it('excludes disabled new agents even when their capability matches', () => {
    const caps = detectCapabilities('summary please')
    const eligible = findEligibleAgents(registry, caps)
    expect(eligible).not.toContain('disabled-new')
  })
})

describe('router.selectAgent — newly registered agents', () => {
  it('selects the qa-capable unit-test-generator for a qa task', () => {
    const registry: AgentRegistry = {
      'unit-test-generator': makeAgent('unit-test-generator', ['qa'], 'experimental'),
      'other': makeAgent('other', ['general'], 'experimental'),
    }
    const selected = selectAgent(registry, 'generate qa tests for this module')
    expect(selected).not.toBeNull()
    if (selected) expect(selected.id).toBe('unit-test-generator')
  })

  it('returns null for a task whose capabilities no new agent declares', () => {
    const registry: AgentRegistry = {
      'recipe-agent': makeAgent('recipe-agent', ['general'], 'experimental'),
      'travel-planner': makeAgent('travel-planner', ['general'], 'experimental'),
    }
    // No keyword matches → empty capability set → no eligible agent.
    const selected = selectAgent(registry, 'plan a surprise birthday party')
    expect(selected).toBeNull()
  })
})
