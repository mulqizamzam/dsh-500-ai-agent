/**
 * Proof tests for ensureVenv single-flight + total (never-throw) contract.
 *
 * Measured host facts behind this file (2026-10-13, `.dev/perfbench4.mjs`):
 *   - `run_agent` is an LLM tool, so PARALLEL calls for the SAME agent are
 *     ordinary. ensureVenv had no lock, and every build begins with
 *     `rmSync(venvDir, {recursive:true, force:true})` — so siblings deleted
 *     each other's work in progress.
 *   - 4 reps per level: conc=3 -> 11 of 12 calls ran a redundant full rebuild;
 *     conc=5 -> 17/20 redundant, 2 unhealthy, 1 REJECTED; conc=8 -> 22/32
 *     redundant, 5 unhealthy, 5 REJECTED.
 *   - `force: true` suppresses ENOENT only. ENOTEMPTY (a directory another
 *     build is actively writing into) propagates as a real exception, and
 *     `ensureVenv` was called OUTSIDE any try/catch at bridge.ts:107, so the
 *     rejection escaped the structured `{status:'error'}` response contract.
 *
 * Every test uses a FAKE `python3` on PATH, so a "build" costs milliseconds
 * instead of the ~17 s a real `python3 -m venv` + pip bootstrap costs. The
 * concurrency the tests assert is the real one — only the venv materialiser
 * is stubbed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureVenv } from '../lib/runtime-manager.js'

const TMP = mkdtempSync(join(tmpdir(), 'dsh500-singleflight-'))
const WORKSPACE = join(TMP, 'workspace')
const OK_BIN = join(TMP, 'okbin')
const FAIL_BIN = join(TMP, 'failbin')

/** Fake `python3` that "builds" a venv instantly (stub interpreter, exit 0). */
const OK_PYTHON3 = [
  '#!/bin/bash',
  'case " $* " in',
  '  *" venv "*)',
  '    venvdir="${@: -1}"',
  '    mkdir -p "$venvdir/bin"',
  '    printf "#!/bin/sh\\nexit 0\\n" > "$venvdir/bin/python"',
  '    chmod +x "$venvdir/bin/python"',
  '    exit 0 ;;',
  '  *) exit 0 ;;',
  'esac',
].join('\n')

/** Fake `python3` where every invocation fails, like an ensurepip-less host. */
const FAIL_PYTHON3 = '#!/bin/sh\necho "ensurepip is not available" >&2\nexit 1\n'

beforeAll(() => {
  mkdirSync(WORKSPACE, { recursive: true })
  mkdirSync(OK_BIN, { recursive: true })
  mkdirSync(FAIL_BIN, { recursive: true })
  writeFileSync(join(OK_BIN, 'python3'), OK_PYTHON3, { mode: 0o755 })
  writeFileSync(join(FAIL_BIN, 'python3'), FAIL_PYTHON3, { mode: 0o755 })
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

/** Run `fn` with `bin` prepended to PATH, then restore PATH. */
async function withPython(bin: string, fn: () => Promise<unknown>): Promise<void> {
  const original = process.env.PATH ?? ''
  process.env.PATH = `${bin}:${original}`
  try {
    await fn()
  } finally {
    process.env.PATH = original
  }
}

/** A cold agent root with an empty requirements file. */
function coldAgent(name: string): string {
  const root = join(TMP, name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'requirements.txt'), '# no dependencies\n')
  return root
}

describe('ensureVenv: concurrent callers share ONE build (single-flight)', () => {
  it('runs exactly one build for 8 concurrent callers and hands them the same result', async () => {
    const root = coldAgent('shared-agent')

    let settled: PromiseSettledResult<Awaited<ReturnType<typeof ensureVenv>>>[] = []
    await withPython(OK_BIN, async () => {
      settled = await Promise.allSettled(
        Array.from({ length: 8 }, () => ensureVenv(root, WORKSPACE, 'shared-agent', 30_000)),
      )
    })

    const rejected = settled.filter((s) => s.status === 'rejected')
    expect(rejected, 'ensureVenv must never reject — the bridge calls it outside any try').toHaveLength(0)

    const states = settled.map((s) => (s.status === 'fulfilled' ? s.value : null))
    expect(states.every((s) => s !== null && s.healthy)).toBe(true)

    // The signal for "exactly one build ran" is object IDENTITY, not the note:
    // every build returns a fresh VenvState, so N callers sharing ONE object
    // means one build served them all. Counting `note === 'created'` would
    // count CALLERS, not builds, and would pass at N builds too.
    expect(new Set(states).size, 'all callers must share one VenvState = one build').toBe(1)
    // And that one build must have been a real one, not a silent reuse.
    expect(states[0]?.note).toBe('created')
    expect(states[0]?.python).toBe(join(root, '.dsh500-venv', 'bin', 'python'))
    expect(existsSync(states[0]!.python)).toBe(true)
  }, 60_000)

  it('does NOT serialise different agents — each root builds its own venv', async () => {
    // Guards the lock key: keying by anything coarser than the agent
    // identity would make unrelated agents share one build.
    const a = coldAgent('agent-a')
    const b = coldAgent('agent-b')

    let settled: PromiseSettledResult<Awaited<ReturnType<typeof ensureVenv>>>[] = []
    await withPython(OK_BIN, async () => {
      settled = await Promise.allSettled([
        ensureVenv(a, WORKSPACE, 'agent-a', 30_000),
        ensureVenv(b, WORKSPACE, 'agent-b', 30_000),
      ])
    })

    const [sa, sb] = settled.map((s) => (s.status === 'fulfilled' ? s.value : null))
    expect(sa?.healthy).toBe(true)
    expect(sb?.healthy).toBe(true)
    expect(sa?.python).toBe(join(a, '.dsh500-venv', 'bin', 'python'))
    expect(sb?.python).toBe(join(b, '.dsh500-venv', 'bin', 'python'))
    // Distinct state objects: neither call was folded into the other.
    expect(sa).not.toBe(sb)
  }, 60_000)
})

describe('ensureVenv: never throws — filesystem errors become a structured state', () => {
  it('resolves with healthy:false when requirements.txt cannot be read', async () => {
    // `existsSync` passes for a directory, then readFileSync throws EISDIR.
    // Before the total contract this rejection escaped bridge.ts:107, which
    // sits outside any try/catch, so the tool call rejected instead of
    // returning the `{status:'error', error:{code:'VENV_UNAVAILABLE'}}` envelope.
    const root = join(TMP, 'unreadable-agent')
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, 'requirements.txt'), { recursive: true })

    const state = await ensureVenv(root, WORKSPACE, 'unreadable-agent', 30_000)

    expect(state.healthy).toBe(false)
    expect(typeof state.error).toBe('string')
    expect(state.error!.length).toBeGreaterThan(0)
    expect(state.note).not.toBe('reused')
    expect(state.note).not.toBe('created')
  }, 30_000)

  it('does not poison the cache — a later call retries after a failed build', async () => {
    // A lock that is never released would return the failure forever and the
    // agent would be permanently broken even once the host recovered.
    const root = coldAgent('retry-agent')

    let failed
    await withPython(FAIL_BIN, async () => {
      failed = await ensureVenv(root, WORKSPACE, 'retry-agent', 30_000)
    })
    expect(failed.healthy).toBe(false)

    let recovered
    await withPython(OK_BIN, async () => {
      recovered = await ensureVenv(root, WORKSPACE, 'retry-agent', 30_000)
    })
    expect(recovered.healthy).toBe(true)
    expect(recovered.note).toBe('created')
    expect(existsSync(recovered.python)).toBe(true)
  }, 60_000)
})