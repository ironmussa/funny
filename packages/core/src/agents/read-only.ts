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
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

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

/**
 * Files under the home directory a sandboxed command never reads: git and
 * GitHub credentials, funny's own data (database, keyring, auth secret) and
 * the agent providers' logins.
 */
const CREDENTIAL_FILES = [
  '.config/gh',
  '.git-credentials',
  '.ssh',
  '.netrc',
  '.funny',
  '.claude/.credentials.json',
  '.codex/auth.json',
];

/** The paths a read-only agent's commands never read: credentials, funny's data, more `hidden`. */
function hiddenPathsFor(home: string, hidden: readonly string[] = []): string[] {
  return [...CREDENTIAL_FILES.map((path) => join(home, path)), ...hidden];
}

/** The Codex permission profile of a read-only agent (see `codexReadOnlyOverrides`). */
const CODEX_PROFILE = 'funny_read_only';

/**
 * The raw `--config` overrides that hold a Codex agent to reading. Codex's own
 * `read-only` sandbox blocks writes and the network but reads every file, so
 * a permission profile extends it with the paths its commands may not read,
 * and the shell environment drops the credentials. The profile is chosen with
 * `default_permissions`, and the thread must NOT pass `--sandbox` as well: Codex
 * then ignores the profile (checked with Codex 0.162). Raw strings, because the
 * SDK's structured `config` would split the paths at their dots.
 */
export function codexReadOnlyOverrides(home: string, hidden: readonly string[] = []): string[] {
  const unreadable = hiddenPathsFor(home, hidden)
    .map((path) => `${JSON.stringify(path)} = "none"`)
    .join(', ');
  return [
    `permissions.${CODEX_PROFILE}.extends=":read-only"`,
    `permissions.${CODEX_PROFILE}.filesystem={ ${unreadable} }`,
    `default_permissions="${CODEX_PROFILE}"`,
    `shell_environment_policy.exclude=${JSON.stringify(CREDENTIAL_ENV_VARS)}`,
    'approval_policy="never"',
  ];
}

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
  /** More paths a command never reads (funny's data folder when it is not `~/.funny`). */
  hidden: readonly string[] = [],
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
      files: hiddenPathsFor(home, hidden).map((path) => ({
        path,
        mode: 'deny' as const,
      })),
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

/** Any non-null object (arrays included). */
function isObject<T>(value: T): value is T & object {
  return typeof value === 'object' && value !== null;
}

/** Flag settings with every settings-file and plugin hook off. */
export interface HooksOffSettings {
  [setting: string]: unknown;
  disableAllHooks: true;
}

/**
 * The flag settings of a read-only agent: the ones it already has, with the
 * hooks of the settings files and plugins off. Those run on the host, outside
 * the sandbox, at every tool call; a command-rewriting one (RTK's) turned `ls`
 * into a command that prints nothing in the sandbox. funny's own pre-tool hook
 * is an SDK callback, not a settings hook, and keeps running.
 */
export function withSettingsHooksOff(settings: Options['settings']): HooksOffSettings {
  const current = isObject(settings) ? settings : {};
  return { ...current, disableAllHooks: true };
}

const ALLOWED = new Set(READ_ONLY_AGENT_TOOLS);

/** A tool call's input, as the SDK's pre-tool hook hands it over; every field is checked. */
type ToolInput = Readonly<Record<string, unknown>>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** A tool input's field when it is a non-empty string, else null. */
function text(input: ToolInput, field: string): string | null {
  const value = input[field];
  return isNonEmptyString(value) ? value : null;
}

/** The folder an absolute glob pattern starts in (its part before the first wildcard). */
function patternRoot(pattern: string | null): string[] {
  if (!pattern || !isAbsolute(pattern)) return [];
  const start = pattern.search(/[*?[{]/);
  return [start === -1 ? pattern : dirname(`${pattern.slice(0, start)}x`)];
}

/** The pattern field of each searching tool. */
const PATTERN_FIELD = new Map(Object.entries({ Glob: 'pattern', Grep: 'glob' }));

/** Where a reading tool looks: its file or folder, or where an absolute pattern starts. */
function targetsOf(toolName: string, input: ToolInput, cwd: string): string[] {
  if (toolName === 'Read') return [text(input, 'file_path') ?? ''];
  const field = PATTERN_FIELD.get(toolName);
  if (!field) return [];
  return [text(input, 'path') ?? cwd, ...patternRoot(text(input, field))];
}

/** A path with its symlinks resolved, as far as it exists (a link inside the checkout can point out). */
function realOf(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Why a read-only agent may not make this call, or null when it may. */ /** Why a read-only agent may not make this call, or null when it may. */
export function readOnlyDenial(
  toolName: string,
  toolInput: ToolInput | null | undefined,
  /** The checkout first, then any other folder its reading tools may read (role inputs). */
  roots: readonly string[],
): string | null {
  if (!ALLOWED.has(toolName)) {
    return `This thread may only read: ${toolName} is not available. Use ${READ_ONLY_AGENT_TOOLS.join(', ')}.`;
  }
  const input: ToolInput = isObject(toolInput) ? toolInput : {};
  if (toolName === 'Bash' && input.dangerouslyDisableSandbox) {
    return 'This thread may only read: commands run in the sandbox, without network or writes.';
  }
  // Read, Glob and Grep run in the agent's own process, outside the sandbox:
  // they may read only the checkout and the role's inputs.
  const [cwd = '/'] = roots;
  const realRoots = roots.map(realOf);
  for (const target of targetsOf(toolName, input, cwd)) {
    const real = realOf(resolve(cwd, target));
    if (!realRoots.some((root) => inside(real, root))) {
      return `This thread may only read its checkout: ${target || '(no path)'} is outside it.`;
    }
  }
  return null;
}
