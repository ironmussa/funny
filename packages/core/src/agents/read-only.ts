/**
 * A read-only Claude agent (`ClaudeProcessOptions.readOnly`): the issue
 * factory's reviewer, triage and sentinel. A list of tools does not hold an
 * agent that has Bash to reading, so its Bash runs in the Claude SDK's OS
 * sandbox (bubblewrap on Linux, Seatbelt on macOS):
 *
 * - no writes to the checkout (the default sandbox writes only there);
 * - no network: hosts outside the empty allow-list are denied, not prompted;
 * - no credentials: the GitHub and provider tokens are unset, and the files
 *   git and gh keep them in cannot be read;
 * - no way out: a command may not ask to run unsandboxed, and a runner where
 *   the sandbox cannot start fails the agent instead of running it unguarded.
 *
 * Two modes, chosen per runner by `detectReadOnlySandboxMode`:
 *
 * - `strict`: the SDK also filters Unix sockets with seccomp. Its helper needs
 *   a user namespace nested inside bubblewrap, which some hosts refuse (Ubuntu's
 *   `bwrap-userns-restrict` AppArmor profile gives bubblewrap's children no
 *   capabilities); there every command fails, closed.
 * - `socket-denylist`: on those hosts Unix sockets are allowed, and the ones a
 *   command could use to run something outside the sandbox are hidden instead
 *   (`ESCAPE_SOCKET_PATHS`: the user's session bus and systemd, Docker, Podman,
 *   X11, tmux, screen). Abstract sockets stay out of reach, since the network
 *   namespace is the sandbox's own. A socket missing from that list would be a
 *   way out: this mode is weaker, and the runner says when it uses it.
 *
 * Every other tool than `READ_ONLY_AGENT_TOOLS` is denied before any saved
 * permission rule is read, and project settings are not loaded (the checkout's
 * `.claude/settings.json` is the change's author's, and its hooks would run
 * outside the sandbox).
 */
import { join } from 'node:path';

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { READ_ONLY_AGENT_TOOLS } from '@funny/shared/models';

import { execute } from '../git/process.js';

/** Environment variables a sandboxed command never sees. */
const CREDENTIAL_ENV_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'SSH_AUTH_SOCK',
];

/** Files under the home directory that hold git and GitHub credentials. */
const CREDENTIAL_FILES = ['.config/gh', '.git-credentials', '.ssh', '.netrc'];

export type ReadOnlySandboxMode = 'strict' | 'socket-denylist';

/** Unix sockets through which a command could run something outside the sandbox. */
export function escapeSocketPaths(uid: number): string[] {
  return [
    `/run/user/${uid}`,
    '/var/run/docker.sock',
    '/run/docker.sock',
    '/run/podman',
    '/tmp/.X11-unix',
    `/tmp/tmux-${uid}`,
    '/run/screen',
  ];
}

/** The SDK `sandbox` option of a read-only agent working in `cwd`. */
export function readOnlySandboxSettings(
  cwd: string,
  home: string,
  mode: ReadOnlySandboxMode = 'strict',
  uid = 0,
): NonNullable<Options['sandbox']> {
  const denylist = mode === 'socket-denylist';
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: denylist
      ? { denyWrite: [cwd], denyRead: escapeSocketPaths(uid) }
      : { denyWrite: [cwd] },
    network: denylist
      ? { allowedDomains: [], strictAllowlist: true, allowAllUnixSockets: true }
      : { allowedDomains: [], strictAllowlist: true },
    credentials: {
      envVars: CREDENTIAL_ENV_VARS.map((name) => ({ name, mode: 'deny' as const })),
      files: CREDENTIAL_FILES.map((path) => ({ path: join(home, path), mode: 'deny' as const })),
    },
  };
}

/**
 * Whether bubblewrap can hold a user namespace nested inside it, which the
 * strict mode's seccomp helper needs: `bwrap … unshare --user --map-root-user`.
 */
const NESTED_USERNS_PROBE = [
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  '--unshare-user',
  '--unshare-pid',
  '--',
  'unshare',
  '--user',
  '--map-root-user',
  'true',
];

let detected: Promise<ReadOnlySandboxMode> | null = null;

/**
 * The mode this runner can hold a read-only agent in, probed once per process.
 * Off Linux, or without bubblewrap, it is `strict`: the SDK then refuses to
 * start the agent rather than run it unguarded.
 */
export function detectReadOnlySandboxMode(
  probe: () => Promise<boolean> = probeNestedUserNamespace,
  platform: string = process.platform,
): Promise<ReadOnlySandboxMode> {
  if (platform !== 'linux') return Promise.resolve('strict');
  detected ??= probe().then((nested) => (nested ? 'strict' : 'socket-denylist'));
  return detected;
}

/** Forget the probed mode (tests). */
export function resetReadOnlySandboxMode(): void {
  detected = null;
}

async function probeNestedUserNamespace(): Promise<boolean> {
  const hasBwrap = await execute('bwrap', ['--version'], { reject: false, timeout: 5_000 }).then(
    (result) => result.exitCode === 0,
    () => false,
  );
  // Without bubblewrap there is no sandbox at all: strict, and the SDK fails closed.
  if (!hasBwrap) return true;
  return execute('bwrap', NESTED_USERNS_PROBE, { reject: false, timeout: 10_000 }).then(
    (result) => result.exitCode === 0,
    () => false,
  );
}

const ALLOWED = new Set(READ_ONLY_AGENT_TOOLS);

/** Why a read-only agent may not make this call, or null when it may. */
export function readOnlyDenial(toolName: string, toolInput: unknown): string | null {
  if (!ALLOWED.has(toolName)) {
    return `This thread may only read: ${toolName} is not available. Use ${READ_ONLY_AGENT_TOOLS.join(', ')}.`;
  }
  const input = toolInput as { dangerouslyDisableSandbox?: unknown } | null;
  if (toolName === 'Bash' && input?.dangerouslyDisableSandbox) {
    return 'This thread may only read: commands run in the sandbox, without network or writes.';
  }
  return null;
}
