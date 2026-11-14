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

import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import {
  createGithubTokenWriter,
  ghCredentialHelper,
  type GithubTokenWriter,
} from '@funny/core/github-app';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { stepOutcomeSchema, type StepOutcome } from '../domain/step-outcome.js';
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

export function createWorktreeWorkspaces(deps: WorktreeWorkspaceDeps): WorkspaceProvider {
  return {
    prepare(request) {
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
        ResultAsync.fromSafePromise(runClean(['git', ...args], { cwd, env })).andThen((run) =>
          run.exitCode === 0
            ? okAsync(run.stdout)
            : errAsync(`git ${args[0]} failed: ${(run.stderr || run.stdout).trim()}`),
        );

      const remoteBase = `refs/remotes/origin/${request.base}`;
      return ResultAsync.fromPromise(
        Promise.all(
          [paths.home, paths.gh].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
        ),
        (error) => `cannot create the run directory: ${String(error)}`,
      )
        .andThen(() => writer.ensure(request.runId).mapErr((e) => `no GitHub token: ${e}`))
        .andThen((token) =>
          git(
            ['fetch', '--quiet', 'origin', `+refs/heads/${request.base}:${remoteBase}`],
            request.projectPath,
          )
            .andThen(() =>
              git(
                ['worktree', 'add', '--quiet', '-b', request.branch, paths.checkout, remoteBase],
                request.projectPath,
              ),
            )
            .map(() => worktreeWorkspace(request, paths, env, writer, token.expiresAt, deps)),
        )
        .orElse((error) =>
          ResultAsync.fromSafePromise(writer.stop()).andThen(() => errAsync(error)),
        );
    },
  };
}

function worktreeWorkspace(
  request: WorkspaceRequest,
  paths: { checkout: string; spec: string; exitMarker: string },
  env: Record<string, string>,
  writer: GithubTokenWriter<string>,
  tokenExpiresAt: string,
  deps: WorktreeWorkspaceDeps,
): RunWorkspace {
  return {
    cwd: paths.checkout,
    async implement(spec) {
      const full = { ...spec, eventsPath: request.eventsPath, exitMarkerPath: paths.exitMarker };
      await writeFile(paths.spec, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
      writer.startRefresh(request.runId, tokenExpiresAt);
      const exitCode = await deps.launchStep({
        specPath: paths.spec,
        cwd: paths.checkout,
        env: { ...env, ANTHROPIC_API_KEY: deps.modelKey },
      });
      return readOutcome(paths.exitMarker, exitCode);
    },
    release: () => writer.stop(),
  };
}

/** The real step runner: `bin/step.ts` as a child process with the run's environment. */
export const childProcessStepLauncher: StepLauncher = async ({ specPath, cwd, env }) => {
  const stepBin = new URL('../bin/step.ts', import.meta.url).pathname;
  const run = await runClean([process.execPath, stepBin, 'implement', '--spec', specPath], {
    cwd,
    env,
  });
  return run.exitCode;
};
