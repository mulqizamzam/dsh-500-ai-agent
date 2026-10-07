/**
 * Per-agent Python venv lifecycle manager.
 *
 * Venv location strategy:
 *   1. Try <agentRoot>/.dsh500-venv (preferred, co-located).
 *   2. Fall back to <workspaceRoot>/venvs/<agentId>/.dsh500-venv
 *      when agent root is read-only (mounted RO catalog, etc.).
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

  // Create venv
  mkdirSync(venvDir, { recursive: true })
  const mkout = await run('python3', ['-m', 'venv', venvDir], { timeoutMs })
  if (mkout.code !== 0) {
    return { root: agentRoot, python: pythonBin, healthy: false, error: `venv creation failed (exit ${mkout.code}): ${failureDetail(mkout, 300)}`, note: 'venv_create_failed' }
  }
  if (!existsSync(pythonBin)) {
    return { root: agentRoot, python: pythonBin, healthy: false, error: `python binary missing at ${pythonBin}`, note: 'venv_create_failed' }
  }

  // Install requirements
  const instOut = await run(pythonBin, ['-m', 'pip', 'install', '-r', requirementsPath], {
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
