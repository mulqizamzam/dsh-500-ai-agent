/**
 * Per-agent Python venv lifecycle manager.
 *
 * Venv location strategy:
 *   1. Try <agentRoot>/.dsh500-venv (preferred, co-located).
 *   2. Fall back to <workspaceRoot>/venvs/<agentId>/.dsh500-venv
 *      when agent root is read-only (mounted RO catalog, etc.).
 *
 * Venv creation strategy:
 *   1. `python3 -m venv` — the standard path, needs ensurepip.
 *   2. When ensurepip is unavailable (Debian/Ubuntu split it into
 *      python3.X-venv, so a bare python3 image lacks it), fall back to
 *      `python3 -m venv --without-pip` plus a SYSTEM-pip bootstrap:
 *      `python3 -m pip --python <venv>/bin/python install -r requirements.txt`.
 *      This keeps per-agent isolation (the packages land in the venv's
 *      site-packages) while only assuming the host has a working pip.
 *
 * All imports are ESM — no require() calls.
 */

import {
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

/** Lifecycle state of one venv entry. */
export interface VenvState {
  root: string
  python: string
  healthy: boolean
  error?: string
  reqHash?: string
  note: string
}

/**
 * Ensure a per-agent venv exists, with fallback to workspace dir when
 * the agent root is read-only.
 */
export async function ensureVenv(
  agentRoot: string,
  workspaceRoot: string,
  agentId: string,
  timeoutMs = 180_000,
): Promise<VenvState> {
  const requirementsPath = join(agentRoot, 'requirements.txt')

  if (!existsSync(agentRoot) || !statSync(agentRoot).isDirectory()) {
    return { root: agentRoot, python: '', healthy: false, error: `agent root missing: ${agentRoot}`, note: 'missing_root' }
  }
  if (!existsSync(requirementsPath)) {
    const venvDir = canWriteDir(agentRoot) ? join(agentRoot, '.dsh500-venv') : join(workspaceRoot, 'venvs', agentId, '.dsh500-venv')
    return { root: agentRoot, python: join(venvDir, 'bin', 'python'), healthy: false, error: `requirements.txt not found at ${requirementsPath}`, note: 'missing_requirements' }
  }

  const reqContent = readFileSync(requirementsPath, 'utf-8')
  const reqHash = createHash('sha256').update(reqContent, 'utf-8').digest('hex')

  // Determine venv location. Reusing a venv needs no write at all, so a
  // healthy primary venv wins before the write probe: the probe fails on a
  // read-only catalog mount even though the venv is sitting right there, and
  // picking the fallback then would discard it (worst case: rebuild attempt).
  const primary = join(agentRoot, '.dsh500-venv')
  const fallback = join(workspaceRoot, 'venvs', agentId, '.dsh500-venv')
  const venvDir = reusableVenv(primary, reqHash) || canWriteDir(agentRoot) ? primary : fallback
  const pythonBin = join(venvDir, 'bin', 'python')

  // Fast path: reuse an existing healthy venv
  if (reusableVenv(venvDir, reqHash)) {
    return { root: agentRoot, python: pythonBin, healthy: true, reqHash, note: 'reused' }
  }

  // Create venv. The standard form needs ensurepip; when the host's python3
  // lacks it (Debian/Ubuntu ship it in the separate python3.X-venv package)
  // the fallback creates the venv without pip and bootstraps it with the
  // SYSTEM pip below. Without this, every agent declaring a venv hard-fails
  // with VENV_UNAVAILABLE on such a host even though a working pip exists.
  mkdirSync(venvDir, { recursive: true })
  const attempts: Array<{ args: string[]; withoutPip: boolean }> = [
    { args: ['-m', 'venv', venvDir], withoutPip: false },
    { args: ['-m', 'venv', '--without-pip', venvDir], withoutPip: true },
  ]
  let created = false
  let withoutPip = false
  const failures: string[] = []
  for (const attempt of attempts) {
    // Each attempt rebuilds from scratch: a half-created venv (the standard
    // form leaves bin/ behind when ensurepip aborts) must not be reused.
    rmSync(venvDir, { recursive: true, force: true })
    const mkout = await run('python3', attempt.args, { timeoutMs })
    if (mkout.code === 0) {
      created = true
      withoutPip = attempt.withoutPip
      break
    }
    failures.push(`python3 ${attempt.args.join(' ')} failed (exit ${mkout.code}): ${failureDetail(mkout, 300)}`)
  }
  if (!created) {
    return {
      root: agentRoot, python: pythonBin, healthy: false,
      error: `venv creation failed: ${failures.join(' | ')}`,
      note: 'venv_create_failed',
    }
  }
  if (!existsSync(pythonBin)) {
    return { root: agentRoot, python: pythonBin, healthy: false, error: `python binary missing at ${pythonBin}`, note: 'venv_create_failed' }
  }

  // Install requirements. A standard venv carries its own pip; the
  // --without-pip fallback is bootstrapped by the system pip pointed at the
  // venv's interpreter, so packages still land in THIS agent's site-packages.
  const pipArgv = withoutPip
    ? ['-m', 'pip', '--python', pythonBin, 'install', '-r', requirementsPath]
    : ['-m', 'pip', 'install', '-r', requirementsPath]
  const instOut = await run(withoutPip ? 'python3' : pythonBin, pipArgv, {
    timeoutMs, cwd: agentRoot, env: { PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONIOENCODING: 'utf-8' },
  })
  if (instOut.code !== 0) {
    rmSync(venvDir, { recursive: true, force: true })
    return { root: agentRoot, python: pythonBin, healthy: false, error: `pip install failed (exit ${instOut.code}): ${failureDetail(instOut, 500)}`, note: 'pip_failed' }
  }

  try { writeFileSync(join(venvDir, '.dsh500-meta.json'), JSON.stringify({ reqHash })) } catch {}
  return { root: agentRoot, python: pythonBin, healthy: true, reqHash, note: 'created' }
}

/**
 * True when `venvDir` holds a venv built from exactly these requirements.
 * Reuse must never write, so this reads only.
 */
function reusableVenv(venvDir: string, reqHash: string): boolean {
  if (!existsSync(join(venvDir, 'bin', 'python'))) return false
  try {
    const meta = JSON.parse(readFileSync(join(venvDir, '.dsh500-meta.json'), 'utf-8')) as { reqHash?: string }
    return meta.reqHash === reqHash
  } catch {
    return false
  }
}

/**
 * Diagnostic text for a failed child process. `python3 -m venv` reports on
 * stdout, pip on stderr — reading stderr alone blanked out the real reason.
 */
function failureDetail(out: { stderr: string; stdout: string }, max: number): string {
  return (out.stderr.trim() || out.stdout.trim()).slice(0, max)
}

function canWriteDir(dir: string): boolean {
  try {
    const probe = join(dir, `.probe-${Date.now()}`)
    writeFileSync(probe, 'x')
    rmSync(probe, { force: true })
    return true
  } catch { return false }
}

async function run(
  cmd: string, args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore','pipe','pipe'], cwd: opts.cwd, env: { ...process.env, ...opts.env } })
    } catch (e) {
      resolve({ code: null, stderr: String(e), stdout: '' })
      return
    }
    let stderr = '', stdout = ''
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8') })
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8') })
    child.on('error', () => resolve({ code: null, stderr, stdout }))
    child.on('close', (code) => resolve({ code, stderr, stdout }))
    if (opts.timeoutMs) {
      const t = setTimeout(() => { try { child!.kill('SIGKILL') } catch {} }, opts.timeoutMs)
      child.on('close', () => clearTimeout(t))
    }
  })
}
