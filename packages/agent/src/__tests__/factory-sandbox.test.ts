/**
 * The whole issue factory with a project in a sandbox, the default workspace
 * kind. The sandbox is `helpers/local-sandbox.ts` (a temp directory, on the
 * provider contract); see `helpers/factory-harness.ts` for the rest of the seam.
 *
 * Tests observe GitHub's state, the project's origin and its worktrees, what
 * the sandbox provider was asked (create requests, commands), the sandbox's
 * files, the run's event file on the host, and `status`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

import { factorySettingsSchema, type FactorySettings } from '../settings/schema.js';
import {
  createFactoryHarness,
  git,
  LOGIN,
  MIN,
  writesHello,
  type FactoryHarness,
  type Turns,
} from './helpers/factory-harness.js';
import type { FakeAgentTurn } from './helpers/step-fakes.js';

let h: FactoryHarness;
beforeEach(() => {
  h = createFactoryHarness();
  h.github.addIssue({
    number: 7,
    author: LOGIN,
    title: 'Add a greeting',
    labels: ['ready-for-agent'],
  });
});
afterEach(() => h.cleanup());

/** The harness project with no workspace kind: the settings' default applies. */
function sandboxSettings(): Partial<FactorySettings> {
  const parsed = factorySettingsSchema.parse({
    github: { login: LOGIN, author: { name: 'Octo Owner', email: 'octo@example.com' } },
    model: 'sonnet',
    sandbox: { provider: 'local' },
    projects: [{ path: h.project, repo: 'acme/app' }],
  });
  return { projects: parsed.projects, sandbox: parsed.sandbox };
}

async function tick(f: { tick(): Promise<void>; idle(): Promise<void> }) {
  await f.tick();
  await f.idle();
}

const runDir = () => join(h.home, 'runs', readdirSync(join(h.home, 'runs'))[0]);
const worktrees = () => git(h.project, 'worktree', 'list').split('\n');

describe('a sandbox factory run', () => {
  test('a project without a workspace kind runs in a sandbox and reaches a draft PR', async () => {
    const { factory: f, store } = h.factory(undefined, sandboxSettings());
    await tick(f);
    store.close();

    expect(h.sandbox!.creates).toHaveLength(1);
    expect(h.github.pulls).toHaveLength(1);
    const pull = h.github.pulls[0];
    expect(pull).toMatchObject({ draft: true, base: 'main' });
    expect(git(h.origin, 'show', `${pull.head}:hello.txt`)).toBe('hello');
    // Every git step ran in the sandbox: no worktree of the project was made.
    expect(worktrees()).toHaveLength(1);
    expect(await h.status()).toContain('waiting_ci');
  });

  test('a sandbox failure fails the run as an infrastructure failure, never with a worktree', async () => {
    const { factory: f, store } = h.factory(undefined, sandboxSettings());
    h.sandbox!.failNextCreate({ kind: 'quota', message: 'too many sandboxes' });
    await tick(f);
    store.close();

    const out = await h.status();
    expect(out).toContain('queued');
    expect(out).toContain('infra failure');
    expect(out).toContain('too many sandboxes');
    expect(h.github.pulls).toHaveLength(0);
    expect(worktrees()).toHaveLength(1);
    expect(readdirSync(runDir())).not.toContain('worktree');
  });

  test('secrets are not in the sandbox create request; they are in root-only files', async () => {
    const { factory: f, store } = h.factory(undefined, sandboxSettings());
    await tick(f);
    store.close();

    const [create] = h.sandbox!.creates;
    expect(create.env).toEqual({});
    expect(JSON.stringify(create)).not.toContain('model-key-for-tests');
    expect(JSON.stringify(create)).not.toContain('ghs_installation_');

    const secrets = join(h.sandboxSecrets, readdirSync(h.sandboxSecrets)[0]);
    expect(statSync(secrets).mode & 0o777).toBe(0o700);
    for (const name of ['model-key', 'github-token']) {
      expect(statSync(join(secrets, name)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(secrets, 'model-key'), 'utf8')).toBe('model-key-for-tests');
    // The scripts the step starts with parse (they never run in this seam).
    const dir = h.sandbox!.dirOf([...h.sandbox!.provider.sandboxes.keys()][0]);
    const work = join(dir, 'factory', readdirSync(join(dir, 'factory'))[0]);
    expect(Bun.spawnSync(['bash', '-n', join(work, 'bin', 'run-step')]).exitCode).toBe(0);
    expect(Bun.spawnSync(['sh', '-n', join(work, 'bin', 'gh')]).exitCode).toBe(0);
    expect(h.github.tokens.map((t) => t.token)).toContain(
      readFileSync(join(secrets, 'github-token'), 'utf8'),
    );
  });

  test('with a provider that writes files, no command carries a secret, renewals included', async () => {
    h.sandboxWritesFiles = true;
    const slow: Turns = (step) => [
      async (call) => {
        const first = step.token();
        h.clock.advance(70 * MIN);
        for (let i = 0; i < 400 && step.token() === first; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        return writesHello(call);
      },
    ];
    const { factory: f, store } = h.factory(slow, sandboxSettings());
    await tick(f);
    store.close();

    expect(h.github.pulls).toHaveLength(1);
    const tokens = h.github.tokens.map((t) => t.token);
    expect(tokens.length).toBeGreaterThan(1);
    const commands = h.sandbox!.provider.commands.map((c) => c.command).join('\n');
    for (const secret of ['model-key-for-tests', ...tokens]) {
      expect(commands).not.toContain(secret);
      expect(commands).not.toContain(Buffer.from(secret).toString('base64'));
    }
    expect(h.sandbox!.provider.writtenFiles.length).toBeGreaterThanOrEqual(3);
    const secrets = join(h.sandboxSecrets, readdirSync(h.sandboxSecrets)[0]);
    expect(readFileSync(join(secrets, 'model-key'), 'utf8')).toBe('model-key-for-tests');
    expect(statSync(join(secrets, 'github-token')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(secrets, 'github-token'), 'utf8')).toBe(tokens[tokens.length - 1]);
    // Nothing is left where the provider wrote it.
    const dir = h.sandbox!.dirOf([...h.sandbox!.provider.sandboxes.keys()][0]);
    for (const { path } of h.sandbox!.provider.writtenFiles) {
      expect(path.startsWith(dir)).toBe(true);
      expect(existsSync(path)).toBe(false);
    }
  });

  test('a run longer than the token lifetime still pushes from inside the sandbox', async () => {
    const slow: Turns = (step) => [
      async (call) => {
        const first = step.token();
        h.clock.advance(70 * MIN);
        // The orchestrator renews the token in the sandbox while the agent works.
        for (let i = 0; i < 400 && step.token() === first; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        return writesHello(call);
      },
    ];
    const { factory: f, store } = h.factory(slow, sandboxSettings());
    await tick(f);
    store.close();

    expect(h.github.pulls).toHaveLength(1);
    expect(h.github.refused).toEqual([]);
    const used = h.github.tokens.find((t) => t.token === h.github.pulls[0].token)!;
    expect(used.expiresAt).toBeGreaterThan(h.clock.now().getTime());
    expect(h.github.tokens[0].expiresAt).toBeLessThan(h.clock.now().getTime());
  });

  test("the step's event file in the sandbox is mirrored to the run's event file", async () => {
    const said: FakeAgentTurn = (call) => {
      writesHello(call);
      return 'Added hello.txt in the sandbox.';
    };
    const { factory: f, store } = h.factory(() => [said], sandboxSettings());
    await tick(f);
    store.close();

    const events = h.events();
    const types = events.map((e) => e.event_type);
    expect(types).toContain('factory.started');
    expect(types).toContain('factory.cli_message');
    expect(types).toContain('factory.completed');
    expect(JSON.stringify(events)).toContain('Added hello.txt in the sandbox.');
    const states = events
      .filter((e) => e.event_type === 'factory.run_state')
      .map((e) => e.data.state);
    expect(states).toEqual(['queued', 'claiming', 'working', 'pr_open', 'waiting_ci']);
  });

  test("a fix runs in the run's own sandbox and pushes from there", async () => {
    const turns: Turns = (step) => [
      (call) => {
        if (step.step === 'implement') return writesHello(call);
        writeFileSync(join(call.cwd, 'hello.txt'), 'hello world\n');
        return 'Fixed in the sandbox.';
      },
    ];
    const { factory: f, store } = h.factory(turns, sandboxSettings());
    await tick(f);
    const pull = h.github.pulls[0];
    pull.checks = [{ name: 'unit', status: 'completed', conclusion: 'failure', log: 'red' }];
    h.clock.advance(3 * MIN);
    await tick(f);
    store.close();

    expect(h.sandbox!.creates).toHaveLength(1);
    expect(git(h.origin, 'show', `${pull.head}:hello.txt`)).toBe('hello world');
    expect(worktrees()).toHaveLength(1);
    // Each step's events reach the host once, the implement step's included.
    const started = h.events().filter((e) => e.event_type === 'factory.started');
    expect(started.map((e) => e.data.step)).toEqual(['implement', 'fix']);
  });

  test('a failed run frees its sandbox; its branch and pull request stay', async () => {
    const turns: Turns = (step) => [
      (call) => {
        if (step.step === 'implement') return writesHello(call);
        throw new Error('I cannot fix this.');
      },
    ];
    const { factory: f, store } = h.factory(turns, sandboxSettings());
    await tick(f);
    const pull = h.github.pulls[0];
    pull.checks = [{ name: 'unit', status: 'completed', conclusion: 'failure', log: 'red' }];
    for (let i = 0; i < 5; i++) {
      h.clock.advance(3 * MIN);
      await tick(f);
    }
    store.close();

    expect(await h.status()).toContain('failed');
    expect(h.sandbox!.provider.sandboxes.size).toBe(0);
    expect(h.github.pulls).toHaveLength(1);
    expect(git(h.origin, 'show', `${pull.head}:hello.txt`)).toBe('hello');
  });
});
