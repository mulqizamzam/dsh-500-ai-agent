/**
 * ensureVenv location + diagnostics.
 *
 * Both cases build a throwaway agent root under tests/.tmp so nothing depends
 * on the host catalog or on ambient venv state:
 *   - read-only root (mode 0555) + healthy primary venv → must REUSE the
 *     primary venv. Reuse needs no write, so a failed write probe must not
 *     push the call onto the workspace fallback.
 *   - venv creation that reports on stdout → the diagnostic must survive,
 *     instead of the empty message stderr-only reporting produced.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ensureVenv } from '../lib/runtime-manager.js'

const TMP = join(process.cwd(), 'tests/.tmp-ensure-venv')
const AGENT_ROOT = join(TMP, 'agent')
const WORKSPACE = join(TMP, 'workspace')
const REQ_HASH = createHash('sha256').update('openai\n', 'utf-8').digest('hex')

/** Fake `python3` that fails the way Debian's `python3 -m venv` does: on stdout. */
const FAKE_BIN = join(TMP, 'fakebin')

function buildAgentRoot(): void {
  mkdirSync(AGENT_ROOT, { recursive: true })
  writeFileSync(join(AGENT_ROOT, 'requirements.txt'), 'openai\n')
  writeFileSync(join(AGENT_ROOT, 'agent.py'), '# stub\n')
  // A healthy venv: python binary + meta hash matching the requirements above.
  mkdirSync(join(AGENT_ROOT, '.dsh500-venv', 'bin'), { recursive: true })
  writeFileSync(join(AGENT_ROOT, '.dsh500-venv', 'bin', 'python'), '#!/bin/sh\nexit 0\n')
  writeFileSync(
    join(AGENT_ROOT, '.dsh500-venv', '.dsh500-meta.json'),
    JSON.stringify({ reqHash: REQ_HASH }),
  )
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  mkdirSync(FAKE_BIN, { recursive: true })
  writeFileSync(
    join(FAKE_BIN, 'python3'),
    '#!/bin/sh\necho "The virtual environment was not created successfully"\nexit 1\n',
    { mode: 0o755 },
  )
  buildAgentRoot()
  // Read-only catalog: the write probe inside ensureVenv must fail here.
  chmodSync(AGENT_ROOT, 0o555)
})

afterAll(() => {
  chmodSync(AGENT_ROOT, 0o755)
  rmSync(TMP, { recursive: true, force: true })
})

describe('ensureVenv: read-only root with an existing healthy venv', () => {
  it('reuses the primary venv instead of falling back to the workspace', async () => {
    const state = await ensureVenv(AGENT_ROOT, WORKSPACE, 'agent', 30_000)

    expect(state.healthy).toBe(true)
    expect(state.note).toBe('reused')
    expect(state.python).toBe(join(AGENT_ROOT, '.dsh500-venv', 'bin', 'python'))
    // The fallback location must not even have been created.
    expect(existsSync(join(WORKSPACE, 'venvs', 'agent'))).toBe(false)
  })
})

describe('ensureVenv: failure diagnostics', () => {
  it('reports the venv failure reason when the child writes it to stdout', async () => {
    const bareRoot = join(TMP, 'bare-agent')
    mkdirSync(bareRoot, { recursive: true })
    writeFileSync(join(bareRoot, 'requirements.txt'), 'openai\n')

    const originalPath = process.env.PATH ?? ''
    process.env.PATH = `${FAKE_BIN}:${originalPath}`
    let state
    try {
      state = await ensureVenv(bareRoot, WORKSPACE, 'bare-agent', 30_000)
    } finally {
      process.env.PATH = originalPath
    }

    expect(state.healthy).toBe(false)
    expect(state.note).toBe('venv_create_failed')
    expect(state.error).toContain('venv creation failed')
    // stderr was empty here — the reason lives on stdout and must be reported.
    expect(state.error).toContain('The virtual environment was not created successfully')
  })
})
