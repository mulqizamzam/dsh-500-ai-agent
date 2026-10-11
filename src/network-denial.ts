/**
 * Network-denial argv surgery — the single place that turns
 * `granted.network === false` into an argv that ACTUALLY denies network.
 *
 * An env-var scrub is not a boundary; a fresh network namespace is. This
 * module owns how `--unshare-net` is layered onto whatever argv is about to
 * be spawned, in every shape that argv can take:
 *
 *   1. The sandbox provider already produced a **bwrap** argv (the common
 *      case on this host: dsh-sandbox's bwrap profile is
 *      `['bwrap', ...mounts, '--', command...]`). `--unshare-net` is a bwrap
 *      flag, so it is injected INTO the existing profile. Wrapping that argv
 *      in a second `bwrap --unshare-net` does NOT nest: the inner runner is
 *      exec'd as the payload command with no profile at all, which both
 *      breaks the run and silently loses the filesystem confinement.
 *   2. The sandbox provider produced a **non-bwrap** runner (Landlock,
 *      Seatbelt, windows-acl). Its flag dialect is not bwrap's, so
 *      `--unshare-net` cannot be injected and a bwrap wrapper would not
 *      nest. The gap is reported (enforcement downgraded to `partial`)
 *      instead of emitting an argv that looks confined but is not.
 *   3. No sandbox provider at all. A bare `bwrap --unshare-net` would leave
 *      the agent full read access to the host filesystem, so the full
 *      profile is built here: host read-only, private /dev, tmpfs /tmp, and
 *      the agent root as the only writable path — read-write only when the
 *      agent's granted filesystem permission says so.
 *
 * Both the bridge (src/bridge.ts) and the RuntimeBackend abstraction
 * (src/runtime-backend.ts) call this. When DEFECT 1 was fixed only in the
 * bridge, this duplication is how the exact same nested-bwrap bug survived
 * in the other module.
 */

import type { EnforcementLevel } from './types.js'

/** What applyNetworkDenial did, for logging and tests. */
export type NetworkDenialAction =
  | 'injected'          // --unshare-net added to an existing bwrap profile
  | 'already-present'   // the profile already denies network; argv untouched
  | 'runner-gap'        // non-bwrap runner in front: network denial NOT enforced
  | 'fallback-profile'  // no sandbox: full bwrap fallback profile built

export interface ApplyNetworkDenialInput {
  /**
   * The argv as it is about to be spawned — possibly already confined by the
   * sandbox provider.
   */
  argv: string[]
  /** True when a sandbox provider was consulted for this run (its runner may be in front of argv). */
  sandboxUsed: boolean
  /** The agent root, needed for the no-sandbox fallback profile. */
  agentRoot: string
  /**
   * Whether the agent may WRITE its root (`granted.filesystem?.mode ===
   * 'readwrite'`). Default-deny: only an explicit readwrite grant turns the
   * root bind read-write; every other grant (null, 'read', 'none') is
   * read-only.
   */
  rootWritable: boolean
}

export interface ApplyNetworkDenialResult {
  argv: string[]
  /**
   * Set only for 'runner-gap' ('partial'). When absent, the caller's own
   * enforcement value (from the sandbox provider) stands.
   */
  enforcement?: EnforcementLevel
  action: NetworkDenialAction
}

/**
 * The profile-flag region of a bwrap argv: everything between the `bwrap`
 * token and the `--` separator. With no separator, bwrap stops parsing
 * options at the first non-flag argument, so the region ends there.
 *
 * The region never includes the command, so a command argument that happens
 * to equal a flag name (a task whose text is literally `--unshare-net`)
 * cannot be mistaken for a profile flag and suppress the injection.
 */
function bwrapProfileFlags(argv: string[]): string[] {
  const separator = argv.indexOf('--')
  if (separator !== -1) return argv.slice(1, separator)
  const flags: string[] = []
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith('-')) break
    flags.push(argv[i])
  }
  return flags
}

export function applyNetworkDenial(input: ApplyNetworkDenialInput): ApplyNetworkDenialResult {
  const { argv, sandboxUsed, agentRoot, rootWritable } = input

  // Case 1: the runner in front IS bwrap — inject into the existing profile.
  if (argv[0] === 'bwrap') {
    if (bwrapProfileFlags(argv).includes('--unshare-net')) {
      return { argv, action: 'already-present' }
    }
    // Prepending after the `bwrap` token keeps every later element — profile,
    // separator, command — in place. bwrap accepts its options in any order
    // ahead of the command.
    return { argv: ['bwrap', '--unshare-net', ...argv.slice(1)], action: 'injected' }
  }

  // Case 2: a non-bwrap runner is in front (Landlock, Seatbelt,
  // windows-acl). Its dialect is not bwrap's; injecting or wrapping would
  // produce an argv that looks confined but is not. Report the gap instead.
  if (sandboxUsed) {
    return { argv, enforcement: 'partial', action: 'runner-gap' }
  }

  // Case 3: no sandbox provider at all. Build the full profile so the run is
  // confined on the filesystem as well as the network.
  return {
    argv: [
      'bwrap',
      '--unshare-net',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      rootWritable ? '--bind' : '--ro-bind', agentRoot, agentRoot,
      '--die-with-parent',
      ...argv,
    ],
    action: 'fallback-profile',
  }
}
