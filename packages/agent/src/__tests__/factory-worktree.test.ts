/**
 * The whole issue factory, worktree mode: domain, state machine, SQLite run
 * store on a temp file, run reporter and the real `implement` step, with fakes
 * only at the edges: GitHub over HTTP (as `fetch`), the agent and the clock.
 *
 * Tests observe only what leaves the factory: GitHub's state (issues, labels,
 * comments, pull requests, the credentials it was shown), the user's own
 * files, the output of `status` and the run's event file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openRunStore } from '../adapters/sqlite-run-store.js';
import { runOrchestratorCli } from '../cli.js';
import { composeFactory } from '../compose.js';
import type { Factory } from '../factory.js';
import { createFactoryLog } from '../infrastructure/factory-log.js';
import type { FactorySettings } from '../settings/schema.js';
import { fakeClock, type FakeClock } from './helpers/fake-clock.js';
import { fakeGithubApi, type FakeGithubApi } from './helpers/fake-github-api.js';
import { ghToken, inProcessStepLauncher } from './helpers/in-process-step.js';
import type { FakeAgentTurn } from './helpers/step-fakes.js';

const REPO = 'acme/app';
const LOGIN = 'octo-owner';
const AUTHOR = { name: 'Octo Owner', email: 'octo@example.com' };
const USER_TOKEN = ['ghp', 'usersownpersonaltoken0123456789abcd'].join('_');
const MIN = 60_000;

const hasGh = (() => {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() }).trim();

let root: string;
let home: string;
let project: string;
let origin: string;
let userHome: string;
let clock: FakeClock;
let github: FakeGithubApi;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'funny-factory-'));
  home = join(root, 'factory-home');
  origin = join(root, 'origin.git');
  project = join(root, 'project');
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

  // The user's own GitHub setup, which the factory must neither use nor touch.
  userHome = join(root, 'user-home');
  mkdirSync(join(userHome, '.config', 'gh'), { recursive: true });
  writeFileSync(
    join(userHome, '.config', 'gh', 'hosts.yml'),
    `github.com:\n    oauth_token: ${USER_TOKEN}\n    user: ${LOGIN}\n`,
  );
  writeFileSync(
    join(userHome, '.gitconfig'),
    '[credential "https://github.com"]\n\thelper = !gh auth git-credential\n',
  );

  clock = fakeClock();
  github = fakeGithubApi({ clock, repo: REPO });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function settings(): FactorySettings {
  return {
    github: { login: LOGIN, author: AUTHOR },
    model: 'sonnet',
    labels: { ready: 'ready-for-agent', in_progress: 'agent-in-progress' },
    limits: { concurrency: 2, daily: 10 },
    auto_merge: false,
    retry_delay_minutes: 30,
    projects: [{ path: project, repo: REPO, workspace: 'worktree' }],
  };
}

const writesHello: FakeAgentTurn = ({ cwd }) => {
  writeFileSync(join(cwd, 'hello.txt'), 'hello\n');
  return 'Added hello.txt.';
};

type Turns = (run: { ghConfigDir: string; factory: Factory }) => FakeAgentTurn[];

function factory(turns: Turns = () => [writesHello]) {
  const store = openRunStore(join(home, 'state.db'));
  const output: string[] = [];
  const log = createFactoryLog(
    { out: (t) => output.push(t), err: (t) => output.push(t) },
    (t) => t,
  );
  // The agent's turns may tick the factory mid-run.
  const ref: { factory?: Factory } = {};
  const built = composeFactory(
    {
      settings: settings(),
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
      launchStep: inProcessStepLauncher({
        github,
        repo: REPO,
        turns: (run) => turns({ ...run, factory: ref.factory! }),
      }),
      // The user's environment, with their personal token in it.
      env: { PATH: process.env.PATH, HOME: userHome, GH_TOKEN: USER_TOKEN },
    },
  );
  ref.factory = built;
  return { factory: built, store, output };
}

async function status(): Promise<string> {
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
}

function events(): Array<{
  event_type: string;
  request_id: string;
  data: Record<string, unknown>;
}> {
  const runs = readdirSync(join(home, 'runs'));
  expect(runs).toHaveLength(1);
  return readFileSync(join(home, 'runs', runs[0], 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('a worktree factory run', () => {
  test('takes a ready issue by the configured login to a draft pull request that closes it', async () => {
    github.addIssue({
      number: 7,
      author: LOGIN,
      title: 'Add a greeting',
      body: 'Write hello.txt containing "hello".',
      labels: ['ready-for-agent'],
    });
    const { factory: f, store } = factory();
    await f.tick();
    await f.idle();
    store.close();

    const issue = github.issues.get(7)!;
    expect(issue.assignees).toEqual([LOGIN]);
    expect(issue.labels).toEqual(['agent-in-progress']);
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0].body).toContain('issue factory');

    expect(github.pulls).toHaveLength(1);
    const pull = github.pulls[0];
    expect(pull).toMatchObject({ draft: true, base: 'main', title: 'Add a greeting' });
    expect(pull.head).toStartWith('factory/issue-7-');
    expect(pull.body).toContain('Closes #7');
    expect(git(origin, 'show', `${pull.head}:hello.txt`)).toBe('hello');
    expect(git(origin, 'log', '-1', '--format=%an <%ae> / %cn <%ce>', pull.head)).toBe(
      'Octo Owner <octo@example.com> / Octo Owner <octo@example.com>',
    );

    const out = await status();
    expect(out).toContain('acme/app#7');
    expect(out).toContain('pr_open');
    expect(out).toContain(pull.url);
    expect(out).toContain('Started today: 1');

    const log = events();
    const states = log.filter((e) => e.event_type === 'factory.run_state').map((e) => e.data.state);
    expect(states).toEqual(['queued', 'claiming', 'working', 'pr_open']);
    expect(log.map((e) => e.event_type)).toContain('factory.completed');
    expect(new Set(log.map((e) => e.request_id)).size).toBe(1);
  });

  test("admits only the configured login's issues, and never two runs for one issue", async () => {
    github.addIssue({ number: 7, author: LOGIN, labels: ['ready-for-agent'] });
    github.addIssue({ number: 8, author: 'stranger', labels: ['ready-for-agent'] });
    const relabelAndTick =
      (run: { factory: Factory }): FakeAgentTurn =>
      async (call) => {
        // While #7 is being worked on, the user labels it ready again and a tick runs.
        github.issues.get(7)!.labels.push('ready-for-agent');
        await run.factory.tick();
        return writesHello(call);
      };
    const { factory: f, store } = factory((run) => [relabelAndTick(run)]);
    await f.tick();
    await f.idle();
    // And again once its pull request is open.
    await f.tick();
    await f.idle();
    store.close();

    expect(github.pulls).toHaveLength(1);
    expect(github.issues.get(7)!.comments).toHaveLength(1);
    const stranger = github.issues.get(8)!;
    expect(stranger).toMatchObject({ assignees: [], labels: ['ready-for-agent'], comments: [] });
    const out = await status();
    expect(out.match(/acme\/app#7/g)).toHaveLength(1);
    expect(out).not.toContain('acme/app#8');
  });

  test("uses the run's own App token, never the user's gh login, git credentials or GH_TOKEN", async () => {
    github.addIssue({ number: 7, author: LOGIN, labels: ['ready-for-agent'] });
    const before = {
      hosts: readFileSync(join(userHome, '.config', 'gh', 'hosts.yml'), 'utf8'),
      gitconfig: readFileSync(join(userHome, '.gitconfig'), 'utf8'),
    };
    const { factory: f, store } = factory();
    await f.tick();
    await f.idle();
    store.close();

    // GitHub saw only App credentials; the pull request came with an installation token.
    expect(github.credentialsSeen.has(USER_TOKEN)).toBe(false);
    expect(github.refused).toEqual([]);
    expect(github.tokens.map((t) => t.token)).toContain(github.pulls[0].token);
    // The user's files are as they were.
    expect(readFileSync(join(userHome, '.config', 'gh', 'hosts.yml'), 'utf8')).toBe(before.hosts);
    expect(readFileSync(join(userHome, '.gitconfig'), 'utf8')).toBe(before.gitconfig);
  });

  test('a run longer than the token lifetime still opens its pull request', async () => {
    github.addIssue({ number: 7, author: LOGIN, labels: ['ready-for-agent'] });
    const slowAgent =
      (run: { ghConfigDir: string }): FakeAgentTurn =>
      async (call) => {
        const first = ghToken({ GH_CONFIG_DIR: run.ghConfigDir });
        clock.advance(70 * MIN);
        // The renewal lands in the run's gh config while the agent works.
        for (let i = 0; i < 200 && ghToken({ GH_CONFIG_DIR: run.ghConfigDir }) === first; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        return writesHello(call);
      };
    const { factory: f, store } = factory((run) => [slowAgent(run)]);
    await f.tick();
    await f.idle();
    store.close();

    expect(github.pulls).toHaveLength(1);
    expect(github.refused).toEqual([]);
    const used = github.tokens.find((t) => t.token === github.pulls[0].token)!;
    expect(used).toBeDefined();
    expect(used.expiresAt).toBeGreaterThan(clock.now().getTime());
    expect(github.tokens[0].expiresAt).toBeLessThan(clock.now().getTime());
  });

  test.skipIf(!hasGh)(
    "the run's git asks gh for the run's current App token, never the project's own helper",
    async () => {
      github.addIssue({ number: 7, author: LOGIN, labels: ['ready-for-agent'] });
      const passwords: string[] = [];
      // `git credential fill` in the step's own environment, as a push would ask.
      const credential = (cwd: string) =>
        /^password=(.*)$/m.exec(
          execFileSync('git', ['credential', 'fill'], {
            cwd,
            encoding: 'utf8',
            input: 'protocol=https\nhost=github.com\npath=acme/app.git\n\n',
          }),
        )?.[1] ?? '';
      const longAgent =
        (run: { ghConfigDir: string }): FakeAgentTurn =>
        async (call) => {
          passwords.push(credential(call.cwd));
          const first = ghToken({ GH_CONFIG_DIR: run.ghConfigDir });
          clock.advance(70 * MIN);
          for (let i = 0; i < 200 && ghToken({ GH_CONFIG_DIR: run.ghConfigDir }) === first; i++) {
            await new Promise((r) => setTimeout(r, 5));
          }
          passwords.push(credential(call.cwd));
          return writesHello(call);
        };
      const { factory: f, store } = factory((run) => [longAgent(run)]);
      await f.tick();
      await f.idle();
      store.close();

      expect(passwords).toHaveLength(2);
      expect(passwords).not.toContain(USER_TOKEN);
      const [before, after] = passwords.map((p) => github.tokens.find((t) => t.token === p));
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect(after!.token).not.toBe(before!.token);
      expect(after!.expiresAt).toBeGreaterThan(clock.now().getTime());
    },
  );
});
