/**
 * The whole issue factory, worktree mode, up to the draft pull request:
 * admission, claiming, the run's own credentials, the `implement` step. See
 * `helpers/factory-harness.ts` for the seam (fakes only at the edges).
 *
 * Tests observe only what leaves the factory: GitHub's state (issues, labels,
 * comments, pull requests, the credentials it was shown), the user's own
 * files, the output of `status` and the run's event file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import type { Factory } from '../factory.js';
import {
  createFactoryHarness,
  git,
  LOGIN,
  MIN,
  USER_TOKEN,
  writesHello,
  type FactoryHarness,
} from './helpers/factory-harness.js';
import { ghToken } from './helpers/in-process-step.js';
import type { FakeAgentTurn } from './helpers/step-fakes.js';

const hasGh = (() => {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let h: FactoryHarness;
beforeEach(() => {
  h = createFactoryHarness();
});
afterEach(() => h.cleanup());

describe('a worktree factory run', () => {
  test('takes a ready issue by the configured login to a draft pull request that closes it', async () => {
    h.github.addIssue({
      number: 7,
      author: LOGIN,
      title: 'Add a greeting',
      body: 'Write hello.txt containing "hello".',
      labels: ['ready-for-agent'],
    });
    const { factory: f, store } = h.factory();
    await f.tick();
    await f.idle();
    store.close();

    const issue = h.github.issues.get(7)!;
    expect(issue.assignees).toEqual([LOGIN]);
    expect(issue.labels).toEqual(['agent-in-progress']);
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0].body).toContain('issue factory');

    expect(h.github.pulls).toHaveLength(1);
    const pull = h.github.pulls[0];
    expect(pull).toMatchObject({ draft: true, base: 'main', title: 'Add a greeting' });
    expect(pull.head).toStartWith('factory/issue-7-');
    expect(pull.body).toContain('Closes #7');
    expect(git(h.origin, 'show', `${pull.head}:hello.txt`)).toBe('hello');
    expect(git(h.origin, 'log', '-1', '--format=%an <%ae> / %cn <%ce>', pull.head)).toBe(
      'Octo Owner <octo@example.com> / Octo Owner <octo@example.com>',
    );

    const out = await h.status();
    expect(out).toContain('acme/app#7');
    expect(out).toContain('waiting_ci');
    expect(out).toContain(pull.url);
    expect(out).toContain('Started today: 1');

    const log = h.events();
    const states = log.filter((e) => e.event_type === 'factory.run_state').map((e) => e.data.state);
    expect(states).toEqual(['queued', 'claiming', 'working', 'pr_open', 'waiting_ci']);
    expect(log.map((e) => e.event_type)).toContain('factory.completed');
    expect(new Set(log.map((e) => e.request_id)).size).toBe(1);
  });

  test("admits only the configured login's issues, and never two runs for one issue", async () => {
    h.github.addIssue({ number: 7, author: LOGIN, labels: ['ready-for-agent'] });
    h.github.addIssue({ number: 8, author: 'stranger', labels: ['ready-for-agent'] });
    const relabelAndTick =
      (run: { factory: Factory }): FakeAgentTurn =>
      async (call) => {
        // While #7 is being worked on, the user labels it ready again and a tick runs.
        h.github.issues.get(7)!.labels.push('ready-for-agent');
        await run.factory.tick();
        return writesHello(call);
      };
    const { factory: f, store } = h.factory((run) => [relabelAndTick(run)]);
    await f.tick();
    await f.idle();
    // And again once its pull request is open.
    await f.tick();
    await f.idle();
    store.close();

    expect(h.github.pulls).toHaveLength(1);
    expect(h.github.issues.get(7)!.comments).toHaveLength(1);
    const stranger = h.github.issues.get(8)!;
    expect(stranger).toMatchObject({ assignees: [], labels: ['ready-for-agent'], comments: [] });
    const out = await h.status();
    expect(out.match(/acme\/app#7/g)).toHaveLength(1);
    expect(out).not.toContain('acme/app#8');
  });

  test("uses the run's own App token, never the user's gh login, git credentials or GH_TOKEN", async () => {
    h.github.addIssue({ number: 7, author: LOGIN, labels: ['ready-for-agent'] });
    const before = {
      hosts: readFileSync(join(h.userHome, '.config', 'gh', 'hosts.yml'), 'utf8'),
      gitconfig: readFileSync(join(h.userHome, '.gitconfig'), 'utf8'),
    };
    const { factory: f, store } = h.factory();
    await f.tick();
    await f.idle();
    store.close();

    // GitHub saw only App credentials; the pull request came with an installation token.
    expect(h.github.credentialsSeen.has(USER_TOKEN)).toBe(false);
    expect(h.github.refused).toEqual([]);
    expect(h.github.tokens.map((t) => t.token)).toContain(h.github.pulls[0].token);
    // The user's files are as they were.
    expect(readFileSync(join(h.userHome, '.config', 'gh', 'hosts.yml'), 'utf8')).toBe(before.hosts);
    expect(readFileSync(join(h.userHome, '.gitconfig'), 'utf8')).toBe(before.gitconfig);
  });

  test('a run longer than the token lifetime still opens its pull request', async () => {
    h.github.addIssue({ number: 7, author: LOGIN, labels: ['ready-for-agent'] });
    const slowAgent =
      (run: { ghConfigDir: string }): FakeAgentTurn =>
      async (call) => {
        const first = ghToken({ GH_CONFIG_DIR: run.ghConfigDir });
        h.clock.advance(70 * MIN);
        // The renewal lands in the run's gh config while the agent works.
        for (let i = 0; i < 200 && ghToken({ GH_CONFIG_DIR: run.ghConfigDir }) === first; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        return writesHello(call);
      };
    const { factory: f, store } = h.factory((run) => [slowAgent(run)]);
    await f.tick();
    await f.idle();
    store.close();

    expect(h.github.pulls).toHaveLength(1);
    expect(h.github.refused).toEqual([]);
    const used = h.github.tokens.find((t) => t.token === h.github.pulls[0].token)!;
    expect(used).toBeDefined();
    expect(used.expiresAt).toBeGreaterThan(h.clock.now().getTime());
    expect(h.github.tokens[0].expiresAt).toBeLessThan(h.clock.now().getTime());
  });

  test.skipIf(!hasGh)(
    "the run's git asks gh for the run's current App token, never the project's own helper",
    async () => {
      h.github.addIssue({ number: 7, author: LOGIN, labels: ['ready-for-agent'] });
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
          h.clock.advance(70 * MIN);
          for (let i = 0; i < 200 && ghToken({ GH_CONFIG_DIR: run.ghConfigDir }) === first; i++) {
            await new Promise((r) => setTimeout(r, 5));
          }
          passwords.push(credential(call.cwd));
          return writesHello(call);
        };
      const { factory: f, store } = h.factory((run) => [longAgent(run)]);
      await f.tick();
      await f.idle();
      store.close();

      expect(passwords).toHaveLength(2);
      expect(passwords).not.toContain(USER_TOKEN);
      const [before, after] = passwords.map((p) => h.github.tokens.find((t) => t.token === p));
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect(after!.token).not.toBe(before!.token);
      expect(after!.expiresAt).toBeGreaterThan(h.clock.now().getTime());
    },
  );
});
