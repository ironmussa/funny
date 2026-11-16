/**
 * Not paying for idle sandboxes while a pull request waits for CI, on both
 * capability modes of `@funny/sandbox`'s fake provider: one that keeps the disk
 * on stop, and one without disk persistence. See `helpers/factory-harness.ts`.
 *
 * Tests observe the fake provider's sandboxes and their states, what the agent
 * saw, the project's origin, GitHub's state and `status`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
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
import type { FakeCheck } from './helpers/fake-github-api.js';

const POLL = 3 * MIN;
const red: FakeCheck[] = [{ name: 'unit', status: 'completed', conclusion: 'failure', log: 'red' }];
const green: FakeCheck[] = [{ name: 'unit', status: 'completed', conclusion: 'success' }];

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

function settings(extra: object = {}): Partial<FactorySettings> {
  const parsed = factorySettingsSchema.parse({
    github: { login: LOGIN, author: { name: 'Octo Owner', email: 'octo@example.com' } },
    model: 'sonnet',
    sandbox: { provider: 'fake' },
    projects: [{ path: h.project, repo: 'acme/app' }],
    ...extra,
  });
  return { projects: parsed.projects, sandbox: parsed.sandbox, auto_merge: parsed.auto_merge };
}

async function tick(f: { tick(): Promise<void>; idle(): Promise<void> }) {
  await f.tick();
  await f.idle();
}

/** Sandboxes by state, from the fake provider. */
const sandboxStates = () => [...h.sandbox!.provider.sandboxes.values()].map((s) => s.state);

/** What the fix saw: its sandbox's state, its session, and whether the agent's session file was there. */
let seen: Array<{ states: string[]; sessionId?: string; sessionFile: boolean }>;
const agent: Turns = (step) => [
  (call) => {
    const sessions = join(process.env.HOME!, '.claude', 'projects', 'repo');
    if (step.step === 'implement') {
      // The agent CLI keeps its session under the sandbox user's home.
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, 'session-1.jsonl'), '{"turn":1}\n');
      return writesHello(call);
    }
    seen.push({
      states: sandboxStates(),
      sessionId: call.sessionId,
      sessionFile: existsSync(join(sessions, 'session-1.jsonl')),
    });
    h.github.pulls[0].checks = green;
    writeFileSync(join(call.cwd, 'hello.txt'), 'hello world\n');
    return 'Fixed.';
  },
];

for (const keepsDisk of [true, false]) {
  const mode = keepsDisk ? 'a provider that keeps the disk' : 'a provider without disk persistence';

  describe(`pausing sandboxes on ${mode}`, () => {
    beforeEach(() => {
      h.sandboxKeepsDisk = keepsDisk;
      seen = [];
    });

    test(
      keepsDisk
        ? 'the sandbox is stopped while waiting for CI and resumed for a fix'
        : 'the sandbox is destroyed while waiting for CI and made again from the branch for a fix, resuming the session',
      async () => {
        const { factory: f, store } = h.factory(agent, settings());
        await tick(f);
        expect(await h.status()).toContain('waiting_ci');
        expect(sandboxStates()).toEqual(keepsDisk ? ['stopped'] : []);

        h.github.pulls[0].checks = red;
        h.clock.advance(POLL);
        await tick(f);
        store.close();

        expect(seen).toHaveLength(1);
        expect(seen[0].states).toEqual(['running']);
        expect(seen[0].sessionId).toBe('session-1');
        expect(seen[0].sessionFile).toBe(true);
        expect(h.sandbox!.creates).toHaveLength(keepsDisk ? 1 : 2);
        expect(git(h.origin, 'show', `${h.github.pulls[0].head}:hello.txt`)).toBe('hello world');
        // Paused again while CI runs on the fix.
        expect(sandboxStates()).toEqual(keepsDisk ? ['stopped'] : []);
      },
    );

    test('no sandbox remains when the factory run merges', async () => {
      const merged = h.factory(agent, settings({ auto_merge: true }));
      await tick(merged.factory);
      h.github.pulls[0].checks = green;
      h.clock.advance(POLL);
      await tick(merged.factory);
      merged.store.close();
      expect(h.github.pulls[0].merged).toBe(true);
      expect(h.sandbox!.provider.sandboxes.size).toBe(0);
    });

    test('no sandbox remains when the factory run is ready', async () => {
      const { factory: f, store } = h.factory(agent, settings());
      await tick(f);
      h.github.pulls[0].checks = green;
      h.clock.advance(POLL);
      await tick(f);
      store.close();
      expect(await h.status()).toContain('ready');
      expect(h.sandbox!.provider.sandboxes.size).toBe(0);
    });

    test('no sandbox remains when the factory run fails', async () => {
      const failing: Turns = (step) => [
        (call) => {
          if (step.step === 'implement') return writesHello(call);
          throw new Error('Cannot fix it.');
        },
      ];
      const { factory: f, store } = h.factory(failing, settings());
      await tick(f);
      h.github.pulls[0].checks = red;
      for (let i = 0; i < 5; i++) {
        h.clock.advance(POLL);
        await tick(f);
      }
      store.close();
      expect(await h.status()).toContain('failed');
      expect(h.sandbox!.provider.sandboxes.size).toBe(0);
    });
  });
}
