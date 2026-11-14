/**
 * Worktree workspaces: a git worktree of the project's local repository, on
 * this machine (trusted repositories only, see the README).
 *
 * The run never uses the user's own GitHub access. It gets a home of its own
 * (`<runDir>/home`), a `gh` config directory holding its Factory App token
 * (`<runDir>/gh`) and a git config whose credential helper asks that `gh`
 * (`<runDir>/gitconfig`). Every git command and the step runner run with
 * exactly that environment, so the user's `gh` login, `~/.gitconfig` and
 * `GH_TOKEN` are neither read nor changed. The token is renewed while the step
 * runs (`@funny/core/github-app`'s writer).
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import { createGithubTokenWriter, ghCredentialHelper } from '@funny/core/github-app';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { stepOutcomeSchema, type StepOutcome } from '../domain/step-outcome.js';
import { AsyncMutex } from '../infrastructure/async-mutex.js';
import { runClean } from '../infrastructure/clean-process.js';
import type { FactoryLog } from '../infrastructure/factory-log.js';
import type { Clock } from '../ports/clock.js';
import type {
  RunWorkspace,
  StepLauncher,
  WorkspaceProvider,
  WorkspaceRequest,
} from '../ports/workspaces.js';
import type { FactoryAppTokens } from './factory-app.js';

/** Variables a run may inherit: none of them carries a credential. */
const INHERITED = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];

const STEP_PID_FILE = 'step.pid';

/**
 * One lock per repository the orchestrator runs git in: factory runs of one
 * project fetch and add worktrees in the same `.git`, and concurrent git
 * commands there fail on its lock files.
 */
const repositoryLocks = new Map<string, AsyncMutex>();
function repositoryLock(path: string): AsyncMutex {
  let lock = repositoryLocks.get(path);
  if (!lock) repositoryLocks.set(path, (lock = new AsyncMutex()));
  return lock;
}

/** The agent session a step's exit marker recorded, if any. */
function readSessionId(exitMarker: string): string | undefined {
  try {
    const marker = stepOutcomeSchema.safeParse(JSON.parse(readFileSync(exitMarker, 'utf8')));
    return marker.success ? marker.data.sessionId : undefined;
  } catch {
    return undefined;
  }
}

const infra = (reason: string): StepOutcome => ({ kind: 'failed', failure: 'infra', reason });

/** The step's exit marker, the source of truth for how it ended. */
async function readOutcome(path: string, exitCode: number): Promise<StepOutcome> {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return infra(`the step exited with ${exitCode} without an exit marker`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return infra('the step wrote an unreadable exit marker');
  }
  const marker = stepOutcomeSchema.safeParse(raw);
  return marker.success ? marker.data : infra('the step wrote an unexpected exit marker');
}

export interface WorktreeWorkspaceDeps {
  tokens: FactoryAppTokens;
  launchStep: StepLauncher;
  clock: Clock;
  log: FactoryLog;
  /** The orchestrator's environment; only `INHERITED` variables pass to a run. */
  env: Readonly<Record<string, string | undefined>>;
  /** Given to the agent as `ANTHROPIC_API_KEY`. */
  modelKey: string;
  /** Author and committer of every commit in the run (the run has no git identity of its own). */
  author: { name: string; email: string };
}

/** A run's paths, environment and token writer, for a new or an existing checkout. */
function runSetup(request: WorkspaceRequest, deps: WorktreeWorkspaceDeps) {
  const paths = {
    home: join(request.runDir, 'home'),
    gh: join(request.runDir, 'gh'),
    gitconfig: join(request.runDir, 'gitconfig'),
    checkout: join(request.runDir, 'worktree'),
    spec: join(request.runDir, 'spec.json'),
    exitMarker: join(request.runDir, 'exit.json'),
  };
  const env: Record<string, string> = {
    ...Object.fromEntries(
      INHERITED.flatMap((name) => (deps.env[name] ? [[name, deps.env[name]!]] : [])),
    ),
    HOME: paths.home,
    GH_CONFIG_DIR: paths.gh,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_CONFIG_GLOBAL: paths.gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: deps.author.name,
    GIT_AUTHOR_EMAIL: deps.author.email,
    GIT_COMMITTER_NAME: deps.author.name,
    GIT_COMMITTER_EMAIL: deps.author.email,
    // Read after every config file, the project's `.git/config` included: an
    // empty helper drops whatever credential helpers came before (a keychain),
    // so only the run's gh answers for github.com.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: ghCredentialHelper(paths.gh),
  };
  const writer = createGithubTokenWriter<string>({
    homeDir: paths.home,
    ghConfigDir: paths.gh,
    gitConfigFile: paths.gitconfig,
    clock: { now: () => deps.clock.now().getTime(), sleep: (ms) => deps.clock.sleep(ms) },
    fetchToken: async () => deps.tokens.forRepo(request.repo).mapErr((e) => e.message),
    onRenewalFailed: (runId, error) =>
      deps.log.warn('Could not renew the factory run token', { run: runId, error }),
  });
  const git = (args: string[], cwd: string) =>
    ResultAsync.fromSafePromise(
      repositoryLock(cwd).runExclusive(() => runClean(['git', ...args], { cwd, env })),
    ).andThen((run) =>
      run.exitCode === 0
        ? okAsync(run.stdout)
        : errAsync(`git ${args[0]} failed: ${(run.stderr || run.stdout).trim()}`),
    );
  /** The run's token, written for gh and git; on failure the writer is stopped. */
  const withToken = <T>(next: (expiresAt: string) => ResultAsync<T, string>) =>
    writer
      .ensure(request.runId)
      .mapErr((e) => `no GitHub token: ${e}`)
      .andThen((token) => next(token.expiresAt))
      .orElse((error) => ResultAsync.fromSafePromise(writer.stop()).andThen(() => errAsync(error)));
  /** The run's home and gh config directory, owner-only. */
  const makeDirs = () =>
    ResultAsync.fromPromise(
      Promise.all(
        [paths.home, paths.gh].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
      ),
      (error) => `cannot create the run directory: ${String(error)}`,
    );
  return { paths, env, writer, git, withToken, makeDirs };
}

export function createWorktreeWorkspaces(deps: WorktreeWorkspaceDeps): WorkspaceProvider {
  return {
    prepare(request) {
      const setup = runSetup(request, deps);
      const { paths, git } = setup;
      const remoteBase = `refs/remotes/origin/${request.base}`;
      return setup.makeDirs().andThen(() =>
        setup.withToken((expiresAt) =>
          removePreviousCheckout(paths.checkout, request.projectPath, git)
            .andThen(() =>
              git(
                ['fetch', '--quiet', 'origin', `+refs/heads/${request.base}:${remoteBase}`],
                request.projectPath,
              ),
            )
            .andThen(() =>
              git(
                ['worktree', 'add', '--quiet', '-b', request.branch, paths.checkout, remoteBase],
                request.projectPath,
              ),
            )
            .map(() => worktreeWorkspace(request, setup, expiresAt, deps)),
        ),
      );
    },
    remove(request) {
      const { paths, git } = runSetup(request, deps);
      return removePreviousCheckout(paths.checkout, request.projectPath, git)
        .andThen(() =>
          // The branch is merged; the local one has no further use.
          git(['branch', '-D', request.branch], request.projectPath).orElse(() => okAsync('')),
        )
        .andThen(() =>
          ResultAsync.fromPromise(
            Promise.all(
              [paths.home, paths.gh, paths.gitconfig, paths.spec, paths.exitMarker].map((path) =>
                rm(path, { recursive: true, force: true }),
              ),
            ),
            (error) => `cannot remove the run's files: ${String(error)}`,
          ),
        )
        .map(() => undefined);
    },
    reopen(request) {
      const setup = runSetup(request, deps);
      const { paths, git } = setup;
      return setup.makeDirs().andThen(() =>
        setup.withToken((expiresAt) => {
          if (existsSync(paths.checkout)) {
            return okAsync(worktreeWorkspace(request, setup, expiresAt, deps));
          }
          // The checkout disappeared (a restart, a cleanup by hand): recreate it
          // from the run's branch as it was pushed.
          const remoteBranch = `refs/remotes/origin/${request.branch}`;
          return git(['worktree', 'prune'], request.projectPath)
            .andThen(() =>
              git(
                ['fetch', '--quiet', 'origin', `+refs/heads/${request.branch}:${remoteBranch}`],
                request.projectPath,
              ),
            )
            .andThen(() =>
              git(
                ['worktree', 'add', '--quiet', '-B', request.branch, paths.checkout, remoteBranch],
                request.projectPath,
              ),
            )
            .map(() => worktreeWorkspace(request, setup, expiresAt, deps));
        }),
      );
    },
    discard: () => okAsync(undefined),
    exists(request) {
      return existsSync(runSetup(request, deps).paths.checkout);
    },
    async stopLeftovers(request) {
      stopLeftoverStep(request.runDir);
    },
    async lastSessionId(request) {
      return readSessionId(runSetup(request, deps).paths.exitMarker);
    },
  };
}

/** A retried factory run starts from a fresh checkout: the previous attempt's goes. */
function removePreviousCheckout(
  checkout: string,
  projectPath: string,
  git: (args: string[], cwd: string) => ResultAsync<string, string>,
): ResultAsync<void, string> {
  if (!existsSync(checkout)) return okAsync(undefined);
  // `worktree remove` fails for a checkout git no longer knows about; the
  // directory is removed and the worktree list pruned either way.
  return git(['worktree', 'remove', '--force', checkout], projectPath)
    .orElse(() => okAsync(''))
    .andThen(() => ResultAsync.fromPromise(rm(checkout, { recursive: true, force: true }), String))
    .andThen(() => git(['worktree', 'prune'], projectPath))
    .map(() => undefined);
}

function worktreeWorkspace(
  request: WorkspaceRequest,
  setup: ReturnType<typeof runSetup>,
  tokenExpiresAt: string,
  deps: WorktreeWorkspaceDeps,
): RunWorkspace {
  const { paths, env, writer } = setup;
  /** One step: its spec in, the step runner, its exit marker out (a stale one removed first). */
  const runStep = async (step: 'implement' | 'fix', spec: object) => {
    const full = { ...spec, eventsPath: request.eventsPath, exitMarkerPath: paths.exitMarker };
    await rm(paths.exitMarker, { force: true });
    await writeFile(paths.spec, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
    writer.startRefresh(request.runId, tokenExpiresAt);
    const exitCode = await deps.launchStep({
      step,
      specPath: paths.spec,
      cwd: paths.checkout,
      env: { ...env, ANTHROPIC_API_KEY: deps.modelKey },
    });
    return readOutcome(paths.exitMarker, exitCode);
  };
  return {
    cwd: paths.checkout,
    implement: (spec) => runStep('implement', spec),
    fix: (spec) => runStep('fix', spec),
    release: () => writer.stop(),
  };
}

/** The real step runner: `bin/step.ts` as a child process with the run's environment. */
export const childProcessStepLauncher: StepLauncher = async ({ step, specPath, cwd, env }) => {
  const stepBin = new URL('../bin/step.ts', import.meta.url).pathname;
  // The pid lets a restarted orchestrator stop a step this process left running.
  const pidFile = join(dirname(specPath), STEP_PID_FILE);
  const run = await runClean([process.execPath, stepBin, step, '--spec', specPath], {
    cwd,
    env,
    onStart: (pid) => writeFileSync(pidFile, String(pid), { mode: 0o600 }),
  });
  rmSync(pidFile, { force: true });
  return run.exitCode;
};

/** Stop a step a previous orchestrator process left running in this run directory. */
function stopLeftoverStep(runDir: string): void {
  const pidFile = join(runDir, STEP_PID_FILE);
  const pid = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : NaN);
  rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}
