/**
 * Network-enforcement test.
 *
 * Requirement 9: "Jangan mengklaim network sandbox hanya berdasarkan
 * environment-variable scrubbing."
 *
 * This test spawns a REAL Python socket probe inside the same
 * `bwrap --unshare-net` wrapper the bridge uses when `permissions.network`
 * is denied, and asserts the connection to 1.1.1.1:443 actually fails at
 * the network layer. If the wrapper is missing (env scrub only) the probe
 * connects and the test fails — proving we are measuring enforcement, not
 * an environment variable.
 *
 * The probe is pure stdlib (`socket`), so no agent dependency is needed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { buildRuntimeConfig } from '../lib/runtime-backend.js'
import { runAgent } from '../lib/bridge.js'
import type { BridgeServices } from '../lib/bridge.js'
import type { AgentRegistryEntry } from '../lib/types.js'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

const PROBE = `
import socket, sys, json
s = socket.socket()
s.settimeout(4)
try:
    s.connect(("1.1.1.1", 443))
    print(json.dumps({"network": "connected"}))
except Exception as e:
    print(json.dumps({"network": "blocked", "err": type(e).__name__}))
s.close()
`

function run(argv: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], cwd, env })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf-8') })
    child.stderr.on('data', (c: Buffer) => { out += c.toString('utf-8') })
    child.on('close', (code) => resolve({ code, out }))
    child.on('error', () => resolve({ code: null, out }))
    setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 20000)
  })
}

describe('network enforcement (real, not env-var scrubbing)', () => {
  let bwrapAvailable = false
  let workDir: string

  beforeAll(() => {
    bwrapAvailable = existsSync('/usr/bin/bwrap')
    workDir = mkdtempSync(join(tmpdir(), 'dsh500-net-'))
    writeFileSync(join(workDir, 'probe.py'), PROBE)
  })

  it('baseline: without unshare-net the socket CONNECTS (proves probe works)', async () => {
    const r = await run(['python3', join(workDir, 'probe.py')], workDir)
    const last = r.out.trim().split('\n').pop() ?? ''
    const parsed = JSON.parse(last) as { network: string }
    // This asserts the probe is meaningful: if this fails the network itself
    // is unreachable and the following negative assertions prove nothing.
    expect(parsed.network).toBe('connected')
  }, 30000)

  it('network denied: buildSpawnResult wraps argv with bwrap --unshare-net', () => {
    const result = buildRuntimeConfig({
      pythonBin: 'python3',
      agentRoot: workDir,
      entrypoint: 'probe.py',
      args: [],
      permissions: { network: false },
      sandbox: undefined,
      backend: 'bubblewrap',
    })

    expect(result.argv[0]).toBe('bwrap')
    expect(result.argv).toContain('--unshare-net')
    expect(result.confined).toBe(false)
    expect(result.networkDenied).toBe(true)
  })

  it('network denied: the wrapped probe is actually blocked at the socket layer', async () => {
    const result = buildRuntimeConfig({
      pythonBin: 'python3',
      agentRoot: workDir,
      entrypoint: 'probe.py',
      args: [],
      permissions: { network: false },
      sandbox: undefined,
      backend: 'bubblewrap',
    })

    const r = await run(result.argv, workDir)
    const last = r.out.trim().split('\n').pop() ?? ''
    const parsed = JSON.parse(last) as { network: string; err?: string }

    // The probe must report "blocked" — a connect() failure at the socket
    // level, not an env var simply being absent.
    expect(parsed.network).toBe('blocked')
    expect(parsed.err).toBeTruthy()
  }, 30000)

  it('network granted: no --unshare-net is injected', () => {
    const result = buildRuntimeConfig({
      pythonBin: 'python3',
      agentRoot: workDir,
      entrypoint: 'probe.py',
      args: [],
      permissions: { network: true },
      sandbox: undefined,
      backend: 'bubblewrap',
    })

    expect(result.argv).not.toContain('--unshare-net')
    expect(result.networkDenied).toBe(false)
  })

  // ── Bridge-level real-process tests ──────────────────────────────────────
  //
  // These exercises the *bridge's* spawn path (not runtime-backend directly)
  // so that the argv produced by src/bridge.ts is the one executed. Two cases:
  //   (A) sandbox absent — the fix must produce a full bwrap profile so that
  //       both network AND filesystem are confined (DEFECT 2).
  //   (B) sandbox present and its confine() returned a bwrap argv — the fix
  //       must inject --unshare-net INTO that profile rather than wrapping
  //       the bwrap argv around itself (DEFECT 1).
  //
  // Both check the observable outcome on a socket probe, not just the argv
  // shape, because argv shapes are the WHAT while the probe is the PROOF.

  const BRIDGE_PROBE = `
import socket, sys, json
def arg(args, name, default=""):
    for i, a in enumerate(args):
        if a == name and i + 1 < len(args):
            return args[i + 1]
    return default
argv = sys.argv[1:]
esc = arg(argv, "--escape")
inside = arg(argv, "--inside")
out = {}
s = socket.socket()
s.settimeout(4)
try:
    s.connect(("1.1.1.1", 443))
    out["network"] = "connected"
except Exception as e:
    out["network"] = "blocked"
    out["net_err"] = type(e).__name__
s.close()
if esc:
    try:
        with open(esc, "w") as f:
            f.write("yes")
        out["host_write"] = "allowed"
    except Exception as e:
        out["host_write"] = "denied"
        out["fs_err"] = type(e).__name__
if inside:
    try:
        with open(inside, "w") as f:
            f.write("yes")
        out["root_write"] = "allowed"
    except Exception as e:
        out["root_write"] = "denied"
        out["root_err"] = type(e).__name__
print(json.dumps(out))
`

  // bwrap presence is checked in beforeAll; these tests run unconditionally
  // so a missing runner fails loudly rather than silently skipping.
  describe('bridge: real-process enforcement', () => {
      let bridgeWorkDir: string
      let spawnLog: string[]

      // Escape sentinels: paths that are host-writable but NOT writable under
      // bwrap confinement (which mounts / read-only and grants write only to
      // the agent root). These are the "outside" writes we use to prove the
      // agent's filesystem is actually confined.
      const ESCAPE_SENTINELS = [
        // A writable location in the plugin workspace, host-writable but
        // inside the bwrap RO mount → must be "denied" under confinement.
        '/home/administrator/agent-workspace/dsh-custom/plugins/dsh-500-ai-agent/.bridge-e2e-escape-A',
        '/home/administrator/agent-workspace/dsh-custom/plugins/dsh-500-ai-agent/.bridge-e2e-escape-B',
      ]

      beforeEach(() => {
        // Recreate per test: afterEach removes the workdir, so a beforeAll
        // setup would leave the second test with a probe.py that no longer
        // exists on disk.
        bridgeWorkDir = mkdtempSync(join(tmpdir(), 'dsh500-bridge-'))
        spawnLog = []
        writeFileSync(join(bridgeWorkDir, 'probe.py'), BRIDGE_PROBE)
      })

      afterAll(() => {
        try { rmSync(bridgeWorkDir, { recursive: true, force: true }) } catch { /* ignore */ }
        for (const f of ESCAPE_SENTINELS) {
          try { rmSync(f) } catch { /* ignore */ }
        }
      })

      afterEach(() => {
        for (const f of ESCAPE_SENTINELS) {
          try { rmSync(f) } catch { /* ignore */ }
        }
        spawnLog = []
      })

      function makeBridgeServices(
        rootDir: string,
        sandboxArgv: string[] | undefined,
        extraFlags?: string[],
      ): BridgeServices {
        const services = {
          subprocess: {
            spawn: (spec: SubprocessSpawnSpec): SubprocessHandle => {
              // The bridge's subprocess seam decides the final argv; our harness
              // actually runs it so the probe outcome is observable end-to-end.
              spawnLog.push(spec.argv.join(' '))
              const stdout = new PassThrough()
              const stderr = new PassThrough()
              const p = spawn(spec.argv[0], spec.argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], cwd: spec.cwd })
              p.stdout.pipe(stdout)
              p.stderr.pipe(stderr)
              return {
                pid: p.pid ?? 0,
                stdin: undefined,
                stdout,
                stderr,
                collected: {},
                done: new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
                  p.once('exit', (code, signal) => resolve({ exitCode: code, signal }))
                  p.once('error', () => resolve({ exitCode: null, signal: 'ERROR' }))
                  setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, 25_000)
                }),
                terminate: () => { try { p.kill('SIGTERM') } catch {} },
              } as unknown as SubprocessHandle
            },
          },
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          workspaceRoot: rootDir,
        }
        if (sandboxArgv) {
          const argv = extraFlags ? [sandboxArgv[0], ...extraFlags, ...sandboxArgv.slice(1)] : sandboxArgv
          services.sandbox = {
            confine: (_raw: readonly string[], _policy: unknown) => ({
              argv,
              enforcement: 'full' as const,
              denialSignatures: ['read-only file system'],
              runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }],
            }),
          }
        }
        return services as unknown as BridgeServices
      }

      function makeProbeEntry(rootDir: string): AgentRegistryEntry {
        return {
          agent_id: 'probe',
          name: 'Probe',
          version: '0.0.1',
          runtime: { type: 'python', version: '3.11' },
          entrypoint: 'probe.py',
          // Each template element is a standalone {{key}} token; the bridge's
          // buildAgentArgs resolves it against input.context.
          entrypoint_args: ['--escape', '{{escape}}', '--inside', '{{inside}}'],
          capabilities: ['general'],
          permissions: { network: false, filesystem: null, shell: false, secrets: [] },
          resources: { timeout_ms: 15_000 },
          source: { repository: 'test', path: '.', commit: 'abc' },
          status: 'experimental',
          root: rootDir,
        }
      }

      it('DEFECT 2 (real): bridge without sandbox denies network AND confines filesystem write', async () => {
        const rootDir = bridgeWorkDir
        const entry = makeProbeEntry(rootDir)
        const services = makeBridgeServices(rootDir, undefined)
        const result = await runAgent(entry, { agent_id: 'probe', task: 'probe', context: {
          escape: ESCAPE_SENTINELS[0],
          inside: join(rootDir, 'inside.txt'),
        } }, services, {
          allowed: true,
          denied: [],
          granted: { network: false, filesystem: null, shell: false, secrets: [] },
        })
        expect(result.status).toBe('success')
        if (result.status !== 'success') return
        // The bridge hands back the PARSED JSON the probe printed.
        const parsed = result.result as Record<string, string>
        // Network probe: a fresh netns means connect() to 1.1.1.1 fails.
        expect(parsed.network).toBe('blocked')
        // Filesystem probe: a write to a host-writable path OUTSIDE the agent
        // root is denied because --ro-bind / / makes the host read-only.
        expect(parsed.host_write).toBe('denied')
        // The default-deny filesystem grant (null) binds the agent root
        // READ-ONLY too: the agent can read its own code but write nothing.
        expect(parsed.root_write).toBe('denied')
        // Sanity: exactly one spawn, argv[0] is bwrap, and the full profile
        // (not just --unshare-net) is present — with the root read-only.
        expect(spawnLog.length).toBe(1)
        const invoked = spawnLog[0].split(' ')
        expect(invoked[0]).toBe('bwrap')
        expect(invoked).toContain('--unshare-net')
        expect(invoked).toContain('--ro-bind')
        expect(invoked).not.toContain('--bind')
        expect(invoked).toContain('--die-with-parent')
      }, 30_000)

      it('filesystem opt-in (real): a readwrite grant makes the agent root writable', async () => {
        const rootDir = bridgeWorkDir
        const entry = makeProbeEntry(rootDir)
        const services = makeBridgeServices(rootDir, undefined)
        const result = await runAgent(entry, { agent_id: 'probe', task: 'probe', context: {
          escape: ESCAPE_SENTINELS[0],
          inside: join(rootDir, 'inside.txt'),
        } }, services, {
          allowed: true,
          denied: [],
          granted: { network: false, filesystem: { mode: 'readwrite', paths: ['.'] }, shell: false, secrets: [] },
        })
        expect(result.status).toBe('success')
        if (result.status !== 'success') return
        const parsed = result.result as Record<string, string>
        expect(parsed.network).toBe('blocked')
        // Host confinement still holds — only the agent root is writable.
        expect(parsed.host_write).toBe('denied')
        // The explicit readwrite grant is what makes the root writable.
        expect(parsed.root_write).toBe('allowed')
        expect(spawnLog.length).toBe(1)
        expect(spawnLog[0].split(' ')).toContain('--bind')
      }, 30_000)

      it('DEFECT 1 (real): bridge with bwrap sandbox injects --unshare-net instead of nesting', async () => {
        const rootDir = bridgeWorkDir
        const escape = ESCAPE_SENTINELS[1]
        const inside = join(rootDir, 'inside.txt')
        // The fake sandbox returns a WORKING bwrap profile WITHOUT
        // --unshare-net (matching DSH's confine(), whose policy vocabulary
        // covers file effects only). The bridge must therefore inject
        // --unshare-net into this existing profile. The buggy code prepended
        // a second `bwrap --unshare-net`, yielding "bwrap --unshare-net
        // bwrap ...". The inner bwrap is then treated as the payload
        // command, the profile never applies, and the process crashes.
        const sandboxBwrapArgv = [
          'bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--tmpfs', '/tmp',
          '--bind', rootDir, rootDir, '--die-with-parent', '--',
          'python3', join(rootDir, 'probe.py'),
          '--escape', escape, '--inside', inside,
        ]
        const entry = makeProbeEntry(rootDir)
        const services = makeBridgeServices(rootDir, sandboxBwrapArgv)
        const result = await runAgent(entry, { agent_id: 'probe', task: 'probe', context: {
          escape,
          inside,
        } }, services, {
          allowed: true,
          denied: [],
          granted: { network: false, filesystem: null, shell: false, secrets: [] },
        })
        // A nested wrapper makes bwrap exec the inner `bwrap` as the payload
        // with no namespace profile; the probe never runs and the bridge
        // reports an error status. Injecting the flag keeps the profile and
        // the probe runs clean.
        expect(result.status).toBe('success')
        if (result.status !== 'success') return
        const parsed = result.result as Record<string, string>
        expect(parsed.network).toBe('blocked')
        expect(parsed.host_write).toBe('denied')
        expect(parsed.root_write).toBe('allowed')
        // The spawn log proves the bwrap argv appears exactly once: a nested
        // wrapper would surface as "bwrap ... bwrap ..." in the same argv.
        expect(spawnLog.length).toBe(1)
        expect((spawnLog[0].match(/\bbwrap\b/g) ?? []).length).toBe(1)
        expect(spawnLog[0].split(' ')).toContain('--unshare-net')
      }, 30_000)
  })
})
