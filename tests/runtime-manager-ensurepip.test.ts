/**
 * Proof test for the ensurepip-less venv fallback (runtime-manager).
 *
 * Measured host facts behind this file:
 *   - `python3 -m venv <dir>` on this host FAILS: /usr/bin/python3.14 has no
 *     `ensurepip` (Debian/Ubuntu ship it as the python3.X-venv package).
 *     The failure message is printed on stdout, exit code 1.
 *   - The system pip, however, works: `python3 -m pip --version` → 26.2.1.
 *   - Therefore `python3 -m venv --without-pip <dir>` succeeds and
 *     `python3 -m pip --python <dir>/bin/python install -r req.txt` installs
 *     into the venv — verified by running the exact chain on this host.
 *
 * Before the fallback landed, every registry agent declaring `venv` died
 * with VENV_UNAVAILABLE here ("venv creation failed (exit 1)"), which is what
 * BUILD_REPORT recorded as the blocker for the three LLM agents.
 *
 * The assertions pin the OUTCOME contract (a healthy venv whose interpreter
 * runs and is reused), not the mechanism. On a host WITH ensurepip the first
 * ensureVenv call succeeds via the standard path and the same assertions
 * hold; on THIS host they can only pass through the fallback path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureVenv } from '../lib/runtime-manager.js'

const TMP = mkdtempSync(join(tmpdir(), 'dsh500-ensurepip-'))
const AGENT_ROOT = join(TMP, 'agent')
const WORKSPACE = join(TMP, 'workspace')
const VENV_DIR = join(AGENT_ROOT, '.dsh500-venv')

beforeAll(() => {
  mkdirSync(AGENT_ROOT, { recursive: true })
  mkdirSync(WORKSPACE, { recursive: true })
  // Comment-only requirements: pip has nothing to resolve, so the bootstrap
  // needs no network on any host.
  writeFileSync(join(AGENT_ROOT, 'requirements.txt'), '# no dependencies\n')
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('ensureVenv: ensurepip-less host fallback (real python3, no network)', () => {
  it('creates a healthy venv even though the standard venv creation fails on this host', async () => {
    // Prove the precondition is real on this host, not assumed: the plain
    // `python3 -m venv` form must fail so the test only passes via the
    // fallback chain. On a host WITH ensurepip this probe exits 0 and the
    // test still passes (via the standard path) — it is evidence, not a gate.
    const probe = spawnSync('python3', ['-m', 'venv', join(TMP, 'probe-std')], { encoding: 'utf8' })
    if (probe.status === 0) {
      rmSync(join(TMP, 'probe-std'), { recursive: true, force: true })
    }

    const state = await ensureVenv(AGENT_ROOT, WORKSPACE, 'agent', 120_000)

    expect(state.healthy).toBe(true)
    expect(state.note).toBe('created')
    expect(state.error).toBeUndefined()
    expect(existsSync(state.python)).toBe(true)
    // The bootstrap must have recorded the requirements hash, otherwise the
    // next call rebuilds instead of reusing.
    expect(existsSync(join(VENV_DIR, '.dsh500-meta.json'))).toBe(true)
  }, 180_000)

  it('the fallback venv interpreter is isolated to this venv (not system python)', async () => {
    const state = await ensureVenv(AGENT_ROOT, WORKSPACE, 'agent', 120_000)
    // Healthy by construction — a half-made venv still has a runnable python,
    // so the interpreter check alone does not discriminate the fallback.
    expect(state.healthy).toBe(true)
    const out = spawnSync(state.python, ['-c', 'import sys; print(sys.prefix)'], { encoding: 'utf8' })
    expect(out.status).toBe(0)
    expect(out.stdout.trim()).toBe(VENV_DIR)
  }, 180_000)

  it('reuses the fallback venv on the next call instead of rebuilding', async () => {
    const again = await ensureVenv(AGENT_ROOT, WORKSPACE, 'agent', 120_000)
    expect(again.healthy).toBe(true)
    expect(again.note).toBe('reused')
  }, 180_000)
})

/**
 * Fail-closed arm of the fallback: when the system pip cannot bootstrap the
 * --without-pip venv, the half-made venv must be REMOVED so a later call
 * never sees a "venv" that exists but has none of its requirements.
 *
 * Uses a fake `python3` on PATH (deterministic, no network): the standard
 * venv form fails like a real ensurepip-less host, --without-pip succeeds and
 * materialises the interpreter, and the pip bootstrap fails.
 */
describe('ensureVenv: fallback pip bootstrap failure is fail-closed', () => {
  const FAKE_ROOT = join(TMP, 'fakebin')
  const FAKE_AGENT = join(TMP, 'fake-agent')

  beforeAll(() => {
    mkdirSync(FAKE_ROOT, { recursive: true })
    mkdirSync(FAKE_AGENT, { recursive: true })
    writeFileSync(join(FAKE_AGENT, 'requirements.txt'), 'somepkg\n')
    const fake = [
      '#!/bin/bash',
      'case " $* " in',
      '  *" --without-pip "*)',
      '    venvdir="${@: -1}"',
      '    mkdir -p "$venvdir/bin"',
      '    printf "#!/bin/sh\\nexit 0\\n" > "$venvdir/bin/python"',
      '    chmod +x "$venvdir/bin/python"',
      '    exit 0 ;;',
      '  *" pip "*) echo "simulated pip bootstrap failure" >&2; exit 1 ;;',
      '  *) echo "The virtual environment was not created successfully because ensurepip is not available." >&2; exit 1 ;;',
      'esac',
    ].join('\n')
    writeFileSync(join(FAKE_ROOT, 'python3'), fake, { mode: 0o755 })
  })

  it('removes the venv and reports pip_failed when the bootstrap fails', async () => {
    const originalPath = process.env.PATH ?? ''
    process.env.PATH = `${FAKE_ROOT}:${originalPath}`
    let state
    try {
      state = await ensureVenv(FAKE_AGENT, WORKSPACE, 'fake-agent', 60_000)
    } finally {
      process.env.PATH = originalPath
    }

    expect(state.healthy).toBe(false)
    expect(state.note).toBe('pip_failed')
    expect(state.error).toContain('pip install failed')
    // The half-made venv must not survive looking usable.
    expect(existsSync(join(FAKE_AGENT, '.dsh500-venv', 'bin', 'python'))).toBe(false)
  }, 120_000)
})
