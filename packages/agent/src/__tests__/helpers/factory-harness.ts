/**
 * The whole-factory test seam: the factory composed with its real parts
 * (domain, state machine, SQLite run store on a temp file, run reporter, the
 * real steps) and fakes only at the edges: GitHub over HTTP (`fetch`), the
 * agent, and the clock.
 *
 * Each harness has its own temp directory: a project repository with a bare
 * `origin`, and a "user home" with the user's own GitHub setup, which the
 * factory must neither use nor touch.
 */

import { execFileSync } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { CreateSandboxRequest, SandboxError, SandboxProvider } from '@funny/sandbox';
import { createFakeSandboxProvider, type FakeSandboxProvider } from '@funny/sandbox/providers/fake';
import { errAsync } from 'neverthrow';

import { openRunStore } from '../../adapters/sqlite-run-store.js';
import { runOrchestratorCli } from '../../cli.js';
import { composeFactory } from '../../compose.js';
import type { Factory } from '../../factory.js';
import { createFactoryLog } from '../../infrastructure/factory-log.js';
import type { RunStore } from '../../ports/run-store.js';
import type { FactorySettings } from '../../settings/schema.js';
import { fakeClock, type FakeClock } from './fake-clock.js';
import { fakeGithubApi, type FakeGithubApi } from './fake-github-api.js';
import { inProcessStepLauncher, type InProcessStepOptions } from './in-process-step.js';
import { sandboxExec } from './local-sandbox.js';
import type { FakeAgentTurn } from './step-fakes.js';

export const REPO = 'acme/app';
export const LOGIN = 'octo-owner';
export const AUTHOR = { name: 'Octo Owner', email: 'octo@example.com' };
export const USER_TOKEN = ['ghp', 'usersownpersonaltoken0123456789abcd'].join('_');
export const MIN = 60_000;

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** Hook-provided GIT_* variables would point git at the wrong repository. */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}
export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() }).trim();

/** The fake agent writes the greeting the issues ask for. */
export const writesHello: FakeAgentTurn = ({ cwd }) => {
  writeFileSync(join(cwd, 'hello.txt'), 'hello\n');
  return 'Added hello.txt.';
};

export interface StepContext {
  ghConfigDir: string;
  step: 'implement' | 'fix';
  /** The token gh would use right now (in a worktree or in a sandbox). */
  token: () => string | null;
  /** The factory itself, so a turn can tick it mid-run. */
  factory: Factory;
}
export type Turns = (step: StepContext) => FakeAgentTurn[];

/** `@funny/sandbox`'s fake provider, with its commands run by `sandboxExec`. */
export interface HarnessSandbox {
  provider: FakeSandboxProvider;
  /** Every create request, as the provider received it. */
  creates: CreateSandboxRequest[];
  /** Make the next create fail with `error`. */
  failNextCreate(error: SandboxError): void;
  dirOf(sandboxId: string): string;
}

export interface RunEvent {
  event_type: string;
  request_id: string;
  data: Record<string, unknown>;
}

export interface FactoryHarness {
  root: string;
  home: string;
  project: string;
  origin: string;
  userHome: string;
  clock: FakeClock;
  github: FakeGithubApi;
  /** The sandbox provider of the last factory made (the project in sandbox mode). */
  sandbox: HarnessSandbox | null;
  /** Whether the next factory's sandbox provider keeps the disk on stop (default true). */
  sandboxKeepsDisk: boolean;
  /** Whether the next factory's sandbox provider has `writeFile` (default false: files go through `exec`). */
  sandboxWritesFiles: boolean;
  /** Root-only secrets of the sandboxes, by run. */
  sandboxSecrets: string;
  /** A factory over the harness; `settings` overrides the defaults. */
  factory(
    turns?: Turns,
    settings?: Partial<FactorySettings>,
  ): { factory: Factory; store: RunStore };
  /** The output of `funny-orchestrator status`. */
  status(): Promise<string>;
  /** The events of the only run, or of `runId`. */
  events(runId?: string): RunEvent[];
  cleanup(): void;
}

/** The fake provider with its commands run by `sandboxExec`, and the provider the factory gets. */
function fakeSandbox(
  root: string,
  steps: InProcessStepOptions,
  keepsDisk: boolean,
  writesFiles: boolean,
): { sandbox: HarnessSandbox; provider: SandboxProvider } {
  const commands = sandboxExec(root, steps);
  const fake = createFakeSandboxProvider('fake-valid', {
    stopPreservesDisk: keepsDisk,
    templates: ['0.0.0-test'],
    exec: commands.exec,
    ...(writesFiles ? { writeFile: commands.writeFile } : {}),
  });
  let nextCreateError: SandboxError | null = null;
  const sandbox: HarnessSandbox = {
    provider: fake,
    creates: [],
    failNextCreate(error) {
      nextCreateError = error;
    },
    dirOf: commands.dirOf,
  };
  // The factory's provider records every create and fails one on demand.
  const provider: SandboxProvider = {
    ...fake,
    create(request) {
      sandbox.creates.push(request);
      const error = nextCreateError;
      nextCreateError = null;
      return error ? errAsync(error) : fake.create(request);
    },
  };
  return { sandbox, provider };
}

export function createFactoryHarness(): FactoryHarness {
  const root = mkdtempSync(join(tmpdir(), 'funny-factory-'));
  const home = join(root, 'factory-home');
  const origin = join(root, 'origin.git');
  const project = join(root, 'project');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: cleanGitEnv() });
  execFileSync('git', ['init', '-q', '-b', 'main', project], { env: cleanGitEnv() });
  git(project, 'config', 'user.name', 'Someone Else');
  git(project, 'config', 'user.email', 'someone@example.com');
  writeFileSync(join(project, 'README.md'), '# app\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'initial');
  git(project, 'remote', 'add', 'origin', origin);
  git(project, 'push', '-q', 'origin', 'main');
  // A credential helper of the user's in the project's own config (a keychain).
  git(
    project,
    'config',
    'credential.helper',
    `!f() { echo username=${LOGIN}; echo password=${USER_TOKEN}; }; f`,
  );

  const userHome = join(root, 'user-home');
  mkdirSync(join(userHome, '.config', 'gh'), { recursive: true });
  writeFileSync(
    join(userHome, '.config', 'gh', 'hosts.yml'),
    `github.com:\n    oauth_token: ${USER_TOKEN}\n    user: ${LOGIN}\n`,
  );
  writeFileSync(
    join(userHome, '.gitconfig'),
    '[credential "https://github.com"]\n\thelper = !gh auth git-credential\n',
  );

  const clock = fakeClock();
  const github = fakeGithubApi({ clock, repo: REPO });

  const settings = (overrides: Partial<FactorySettings>): FactorySettings => ({
    github: { login: LOGIN, author: AUTHOR },
    model: 'sonnet',
    labels: { ready: 'ready-for-agent', in_progress: 'agent-in-progress' },
    limits: { concurrency: 2, daily: 10 },
    auto_merge: false,
    retry_delay_minutes: 30,
    projects: [{ path: project, repo: REPO, workspace: 'worktree' }],
    ...overrides,
  });

  const sandboxSecrets = join(root, 'sandbox-secrets');
  mkdirSync(join(root, 'sandboxes'), { recursive: true });
  const harness: FactoryHarness = {
    root,
    home,
    project,
    origin,
    userHome,
    clock,
    github,
    sandbox: null,
    sandboxKeepsDisk: true,
    sandboxWritesFiles: false,
    sandboxSecrets,
    factory(turns = () => [writesHello], overrides = {}) {
      const store = openRunStore(join(home, 'state.db'));
      const log = createFactoryLog({ out: () => {}, err: () => {} }, (t) => t);
      const ref: { factory?: Factory } = {};
      const steps: InProcessStepOptions = {
        github,
        repo: REPO,
        turns: (step) => turns({ ...step, factory: ref.factory! }),
      };
      const sandboxed = fakeSandbox(
        join(root, 'sandboxes'),
        steps,
        harness.sandboxKeepsDisk,
        harness.sandboxWritesFiles,
      );
      harness.sandbox = sandboxed.sandbox;
      const built = composeFactory(
        {
          settings: settings(overrides),
          secrets: {
            modelKey: 'model-key-for-tests',
            app: { appId: '5690396', privateKey },
            sandboxCredential: null,
          },
          store,
          log,
          home,
        },
        {
          fetch: github.fetch,
          api: github.api,
          clock,
          launchStep: inProcessStepLauncher(steps),
          sandboxProvider: sandboxed.provider,
          runnerBuild: {
            commit: 'a'.repeat(40),
            version: '0.0.0-test',
            repoUrl: 'https://example.test/funny.git',
          },
          sandboxLayout: { secretsRoot: sandboxSecrets, sudo: '', cloneUrl: () => origin },
          sandboxPollMs: 5,
          // The user's environment, with their personal token in it.
          env: { PATH: process.env.PATH, HOME: userHome, GH_TOKEN: USER_TOKEN },
          admissionTimeoutMs: 1_000,
        },
      );
      ref.factory = built;
      return { factory: built, store };
    },
    async status() {
      let out = '';
      await runOrchestratorCli(['status'], {
        env: { FUNNY_FACTORY_HOME: home },
        stdout: (t) => void (out += t),
        stderr: (t) => void (out += t),
        isTTY: false,
        prompt: async () => null,
        now: () => clock.now(),
        untilStopped: async () => {},
      });
      return out;
    },
    events(runId) {
      const runs = readdirSync(join(home, 'runs'));
      const id = runId ?? (runs.length === 1 ? runs[0] : undefined);
      if (!id) throw new Error(`expected one run, found ${runs.length}`);
      return readFileSync(join(home, 'runs', id, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return harness;
}
