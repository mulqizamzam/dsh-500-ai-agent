/**
 * Locks the stdout contract that `agent_contract.py` implements.
 *
 * The bridge treats stdout as the agent's output and parses exactly one JSON
 * object out of it. Two defects made that fail, and both were silent:
 *
 *  1. A dict/list result was wrapped in a SECOND envelope whose `status` was
 *     hardcoded to 'success'. The bridge wrapped once more, so a caller reading
 *     `result.status` saw 'success' while the agent had actually failed
 *     (fail-closed CRITICAL). The e2e suite caught this.
 *  2. Noise printed by an agent ('INPUT :', demo banners) landed on stdout and
 *     was fed to the JSON parser.
 *
 * This file owns the canonical `agent_contract.py` that lives at the repo root.
 * The 17 agent folders in the upstream checkout each carry their own copy, and
 * those copies are not tracked by the upstream repo, so nothing keeps them in
 * sync. `contract copies match the canonical file` is the drift gate for that;
 * delete the copy when the upstream checkout is absent rather than skipping.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const canonicalPath = join(here, '..', 'agent_contract.py')

/** Run the canonical contract in a fresh interpreter and return stdout. */
function runContract(body: string): string {
  const result = spawnSync(
    'python3',
    ['-c', `import agent_contract, sys\n${body}`],
    {
      encoding: 'utf-8',
      cwd: join(here, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (result.error) throw result.error
  expect(result.status).toBe(0)
  return result.stdout
}

describe('agent_contract: stdout shape', () => {
  it('prints a dict result verbatim, without a second envelope', () => {
    const stdout = runContract(
      [
        'agent_contract.prepare_output()',
        'print("noise banner that must not reach stdout")',
        "agent_contract.finish({'status': 'error', 'risk_category': 'CRITICAL'}, [])",
      ].join('\n'),
    )
    const parsed = JSON.parse(stdout) as Record<string, unknown>

    // The agent's own status must survive. Wrapping this in a hardcoded
    // 'success' is the defect that made a failed sanitization look successful.
    expect(parsed.status).toBe('error')
    expect(parsed.risk_category).toBe('CRITICAL')

    // No envelope keys: the bridge emits the outer shape itself, so a second
    // one here would double-nest and hide the agent's fields.
    expect(parsed).not.toHaveProperty('result')
    expect(parsed).not.toHaveProperty('artifacts')
    expect(parsed).not.toHaveProperty('metadata')
  })

  it('prints a list result verbatim', () => {
    const stdout = runContract(
      'agent_contract.prepare_output()\nagent_contract.finish([{"a": 1}], [])',
    )
    expect(JSON.parse(stdout)).toEqual([{ a: 1 }])
  })

  it('keeps the envelope for a string result, since a string has no JSON shape', () => {
    const stdout = runContract(
      "agent_contract.prepare_output()\nagent_contract.finish('plain text', ['out.txt'])",
    )
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    expect(parsed.status).toBe('success')
    expect(parsed.result).toBe('plain text')
    expect(parsed.artifacts).toEqual(['out.txt'])
    expect(parsed.metadata).toHaveProperty('agent_id')
  })

  it('sends progress noise to stderr, leaving stdout with exactly one JSON object', () => {
    const result = spawnSync(
      'python3',
      [
        '-c',
        [
          'import agent_contract',
          'agent_contract.prepare_output()',
          'print("INPUT : some user text")',
          'print("progress 50%")',
          "agent_contract.finish({'status': 'success'}, [])",
        ].join('\n'),
      ],
      { encoding: 'utf-8', cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    expect(result.status).toBe(0)

    // stdout must parse as JSON on its own. Before prepare_output() existed
    // these lines preceded the JSON and the parser saw the noise.
    expect(() => JSON.parse(result.stdout)).not.toThrow()

    // The noise is not swallowed, it is routed to stderr for the log stream.
    expect(result.stderr).toContain('INPUT : some user text')
    expect(result.stderr).toContain('progress 50%')
  })

  it('raises rather than emitting an envelope when prepare_output() was skipped', () => {
    const result = spawnSync(
      'python3',
      ['-c', "import agent_contract\nagent_contract.finish({'status': 'success'}, [])"],
      { encoding: 'utf-8', cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('prepare_output')
  })
})

describe('agent_contract: copies match the canonical file', () => {
  const agentsRoot = join(here, '..', '..', '..', '..', '500-AI-Agents-Projects', 'agents')
  let canonicalHash: string
  let copies: string[] = []

  beforeAll(() => {
    canonicalHash = createHash('sha256')
      .update(readFileSync(canonicalPath))
      .digest('hex')

    if (!existsSync(agentsRoot)) return
    const listing = spawnSync('ls', [agentsRoot], { encoding: 'utf-8' })
    copies = listing.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name.length > 0)
      .map((name) => join(agentsRoot, name, 'agent_contract.py'))
      .filter((path) => existsSync(path))
  })

  afterAll(() => {
    copies = []
  })

  it('the canonical file is valid Python', () => {
    const result = spawnSync('python3', ['-m', 'py_compile', canonicalPath], {
      encoding: 'utf-8',
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  // A wrong path and an absent checkout look identical here, so an early
  // `return` would turn both into a silent pass. `ctx.skip()` keeps the gap
  // visible in the run output instead of hiding it behind green.
  it('found agent copies to check', (ctx) => {
    if (!existsSync(agentsRoot)) {
      ctx.skip(`upstream checkout absent at ${agentsRoot}`)
      return
    }
    expect(copies.length, `no agent_contract.py found under ${agentsRoot}`).toBeGreaterThan(0)
  })

  it('every agent copy is byte-identical to the canonical file', (ctx) => {
    if (!existsSync(agentsRoot) || copies.length === 0) {
      ctx.skip('upstream checkout absent, nothing to drift')
      return
    }

    const drifted = copies.filter(
      (path) =>
        createHash('sha256').update(readFileSync(path)).digest('hex') !== canonicalHash,
    )
    expect(
      drifted,
      `these agent_contract.py copies drifted from ${canonicalPath}:\n${drifted.join('\n')}`,
    ).toEqual([])
  })
})