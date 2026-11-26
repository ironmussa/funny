import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import { handleDataMessageWithAck } from '../../services/data-handler.js';
/**
 * Project scope on the runner→server data channel (project-runner-binding):
 * a dedicated runner can only read/write its own project's data, even when
 * every project belongs to the same user.
 */
import { resetDataOwnershipCache } from '../../services/data-ownership.js';
import {
  DATA_SCOPE_RULES,
  resetDataScopeCache,
  canRunnerActOnThread,
} from '../../services/data-scope.js';
import {
  resetRunnerScopeCache,
  grantProjectRunner,
  setProjectDedicatedRunner,
  setProjectGithubToken,
} from '../../services/runner-scope.js';
import { seedMessage, seedProject, seedRunner, seedThread } from '../helpers/test-db.js';

// The keyring is resolved on first use, so this is in place before any secret is saved.
process.env.FUNNY_ENCRYPTION_KEYS = JSON.stringify({ active: 'k1', keys: { k1: 'cd'.repeat(32) } });

const FORBIDDEN = { type: 'data:ack', success: false, error: 'Forbidden' };

describe('DATA_SCOPE_RULES coverage', () => {
  test('every data:* type handled by data-handler has a scope rule', () => {
    // The dispatch table spans data-message-handlers.ts and its sibling modules.
    const source = ['data-message-handlers.ts', 'data-message-handlers-watchers-jobs.ts']
      .map((file) => readFileSync(join(import.meta.dir, '../../services', file), 'utf8'))
      .join('\n');
    const handled = [...source.matchAll(/^ {2}'(data:[a-z_]+)': async /gm)].map((m) => m[1]);
    expect(handled.length).toBeGreaterThan(40);
    const missing = handled.filter((type) => !DATA_SCOPE_RULES[type]);
    expect(missing).toEqual([]);
  });
});

describe('dedicated runner data scope', () => {
  let db: (typeof import('../../db/index.js'))['db'];

  beforeAll(async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    db = (await import('../../db/index.js')).db;
  });

  beforeEach(async () => {
    for (const table of [
      'project_runner_grants',
      'project_runner_settings',
      'project_secrets',
      'messages',
      'threads',
      'runner_project_assignments',
      'runners',
      'projects',
    ]) {
      db.run(`DELETE FROM ${table}`);
    }
    resetRunnerScopeCache();
    resetDataScopeCache();
    resetDataOwnershipCache();
    seedProject(db, { id: 'px', userId: 'alice', path: '/x' });
    seedProject(db, { id: 'py', userId: 'alice', path: '/y' });
    seedThread(db, { id: 'tx', projectId: 'px', userId: 'alice' });
    seedThread(db, { id: 'ty', projectId: 'py', userId: 'alice' });
    seedThread(db, {
      id: 'ts',
      projectId: null,
      userId: 'alice',
      isScratch: 1,
    });
    seedMessage(db, { id: 'my', threadId: 'ty' });
    seedRunner(db, { id: 'laptop', userId: 'alice', token: 'tok-l', hostname: 'l' });
    seedRunner(db, {
      id: 'rx',
      userId: 'alice',
      token: 'tok-rx',
      hostname: 'rx',
      role: 'dedicated',
    });
    await setProjectDedicatedRunner('px', 'alice', 'rx');
  });

  afterAll(async () => {
    const { closeDatabase } = await import('../../db/index.js');
    await closeDatabase?.();
  });

  const send = (runnerId: string, data: any) => handleDataMessageWithAck(runnerId, 'alice', data);

  test('reads and writes on its own project are allowed', async () => {
    const res = await send('rx', { type: 'data:get_thread', threadId: 'tx' });
    expect(res.thread?.id).toBe('tx');
    const ins = await send('rx', {
      type: 'data:insert_message',
      threadId: 'tx',
      payload: { threadId: 'tx', role: 'assistant', content: 'hi' },
    });
    expect(ins.type).toBe('data:insert_message_response');
  });

  test("another project's thread, message and project are refused", async () => {
    expect(await send('rx', { type: 'data:get_thread', threadId: 'ty' })).toEqual(FORBIDDEN);
    expect(
      await send('rx', {
        type: 'data:update_message',
        payload: { messageId: 'my', content: 'x' },
      }),
    ).toEqual(FORBIDDEN);
    expect(await send('rx', { type: 'data:get_project', projectId: 'py' })).toEqual(FORBIDDEN);
    expect(
      await send('rx', {
        type: 'data:create_thread',
        payload: { id: 't-new', projectId: 'py', userId: 'alice', title: 'x' },
      }),
    ).toEqual(FORBIDDEN);
  });

  test('projectless work is refused on a dedicated runner', async () => {
    expect(await send('rx', { type: 'data:get_thread', threadId: 'ts' })).toEqual(FORBIDDEN);
    expect(
      await send('rx', { type: 'data:create_project', name: 'n', path: '/n', userId: 'alice' }),
    ).toEqual(FORBIDDEN);
  });

  test('the general runner loses access to a pinned project but keeps the rest', async () => {
    expect(await send('laptop', { type: 'data:get_thread', threadId: 'tx' })).toEqual(FORBIDDEN);
    expect((await send('laptop', { type: 'data:get_thread', threadId: 'ty' })).thread?.id).toBe(
      'ty',
    );
    expect((await send('laptop', { type: 'data:get_thread', threadId: 'ts' })).thread?.id).toBe(
      'ts',
    );
  });

  test('an explicit grant opens access', async () => {
    await grantProjectRunner('py', 'alice', 'rx');
    expect((await send('rx', { type: 'data:get_thread', threadId: 'ty' })).thread?.id).toBe('ty');
  });

  test('listings are filtered to accessible projects', async () => {
    const rx = await send('rx', { type: 'data:list_projects', userId: 'alice' });
    expect(rx.projects.map((p: any) => p.id)).toEqual(['px']);
    const laptop = await send('laptop', { type: 'data:list_projects', userId: 'alice' });
    expect(laptop.projects.map((p: any) => p.id)).toEqual(['py']);
  });

  test('agent events: only own-user threads inside the runner scope', async () => {
    seedThread(db, { id: 'bob-t', projectId: 'px', userId: 'bob' });
    expect(await canRunnerActOnThread('rx', 'alice', 'tx')).toBe(true);
    expect(await canRunnerActOnThread('rx', 'alice', 'ty')).toBe(false);
    expect(await canRunnerActOnThread('rx', 'alice', 'ts')).toBe(false);
    expect(await canRunnerActOnThread('laptop', 'alice', 'ts')).toBe(true);
    expect(await canRunnerActOnThread('rx', 'alice', 'bob-t')).toBe(false);
    expect(await canRunnerActOnThread('rx', 'alice', 'missing')).toBe(false);
  });

  test('git credential: project token overrides the personal one, only inside scope', async () => {
    await setProjectGithubToken('px', 'ghp_project_x');
    const explicit = await send('rx', {
      type: 'data:get_github_token',
      userId: 'alice',
      projectId: 'px',
    });
    expect(explicit.token).toBe('ghp_project_x');
    // A dedicated runner pinned to one project gets that project's token by default.
    const implicit = await send('rx', { type: 'data:get_github_token', userId: 'alice' });
    expect(implicit.token).toBe('ghp_project_x');
    // A runner outside the project's scope cannot ask for its token.
    expect(
      await send('laptop', { type: 'data:get_github_token', userId: 'alice', projectId: 'px' }),
    ).toEqual(FORBIDDEN);
    // Projects without an override fall back to the user's token (none here).
    const fallback = await send('laptop', {
      type: 'data:get_github_token',
      userId: 'alice',
      projectId: 'py',
    });
    expect(fallback.token).toBeNull();
  });

  test('project secrets: only a runner in the project scope that belongs to the thread owner', async () => {
    const { projectSecretsService } = await import('../../services/project-secrets.js');
    const { log } = await import('../../lib/logger.js');
    (
      await projectSecretsService().set('alice', {
        projectId: 'px',
        scope: 'project',
        name: 'API_KEY',
        value: 'px-secret-value',
        allowInSandbox: false,
      })
    )._unsafeUnwrap();
    const ask = { type: 'data:get_project_secrets', threadId: 'tx' };

    // The project's dedicated runner gets them.
    expect(await send('rx', ask)).toEqual({
      type: 'data:get_project_secrets_response',
      secrets: [{ name: 'API_KEY', value: 'px-secret-value' }],
    });

    // A runner of the same user outside the project's scope is refused and audited.
    const info = spyOn(log, 'info');
    expect(await send('laptop', ask)).toEqual(FORBIDDEN);
    const denials = info.mock.calls
      .map((call) => JSON.stringify(call))
      .filter((call) => call.includes('[AUDIT] runner.scope_denied'));
    expect(denials).toHaveLength(1);
    expect(denials[0]).toContain('"runnerId":"laptop"');
    expect(denials[0]).toContain('"type":"data:get_project_secrets"');
    info.mockRestore();

    // Another user's runner is refused by the ownership check.
    seedRunner(db, { id: 'bob-laptop', userId: 'bob', token: 'tok-b', hostname: 'b' });
    const fromBob = await handleDataMessageWithAck('bob-laptop', 'bob', ask);
    expect(fromBob).toEqual(FORBIDDEN);
    expect(JSON.stringify(fromBob)).not.toContain('px-secret-value');

    // A scratch thread has no project secrets.
    expect(await send('laptop', { type: 'data:get_project_secrets', threadId: 'ts' })).toEqual({
      type: 'data:get_project_secrets_response',
      secrets: [],
    });
  });

  test("the factory tools answer the thread owner's runner, and offer no approval", async () => {
    const list = { type: 'data:factory_list_runs', threadId: 'tx' };
    // No factory yet: an answer, not an error.
    expect(await send('rx', list)).toEqual({
      type: 'data:factory_list_runs_response',
      factory: false,
      runs: [],
    });
    // A runner outside the project's scope, and another user's runner, are refused.
    expect(await send('laptop', list)).toEqual(FORBIDDEN);
    seedRunner(db, { id: 'bob-laptop', userId: 'bob', token: 'tok-b', hostname: 'b' });
    expect(await handleDataMessageWithAck('bob-laptop', 'bob', list)).toEqual(FORBIDDEN);

    // Only the named run controls: a runner cannot name an approval, a split or a state.
    for (const action of ['approve-merge', 'approve', 'split', 'done', '']) {
      const res = await send('rx', {
        type: 'data:factory_control_run',
        threadId: 'tx',
        runId: 'r1',
        action,
        expectedSha: 'a'.repeat(40),
      });
      expect(res).toEqual({
        type: 'data:factory_control_run_response',
        error: 'refused',
        message:
          'The action must be one of: retry, stop, mark-done, hold, release, close-replaced-pr.',
      });
    }

    // A scratch thread has no factory to reach.
    const scratch = await send('laptop', { type: 'data:factory_list_runs', threadId: 'ts' });
    expect(scratch).toMatchObject({ type: 'data:factory_list_runs_response', error: 'refused' });
  });

  test('user-level settings stay available to dedicated runners', async () => {
    const res = await send('rx', { type: 'data:get_profile', userId: 'alice' });
    expect(res.type).toBe('data:get_profile_response');
  });
});
