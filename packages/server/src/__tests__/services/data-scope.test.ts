/**
 * Project scope on the runner→server data channel (project-runner-binding):
 * a dedicated runner can only read/write its own project's data, even when
 * every project belongs to the same user.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import { handleDataMessageWithAck } from '../../services/data-handler.js';
import {
  DATA_SCOPE_RULES,
  __resetDataScopeCache,
  canRunnerActOnThread,
} from '../../services/data-scope.js';
import {
  __resetRunnerScopeCache,
  grantProjectRunner,
  setProjectDedicatedRunner,
  setProjectGithubToken,
} from '../../services/runner-scope.js';
import { seedMessage, seedProject, seedRunner, seedThread } from '../helpers/test-db.js';

const FORBIDDEN = { type: 'data:ack', success: false, error: 'Forbidden' };

describe('DATA_SCOPE_RULES coverage', () => {
  test('every data:* type handled by data-handler has a scope rule', () => {
    const source = readFileSync(join(import.meta.dir, '../../services/data-handler.ts'), 'utf8');
    const handled = [...source.matchAll(/case '(data:[a-z_]+)'/g)].map((m) => m[1]);
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
      'messages',
      'threads',
      'runner_project_assignments',
      'runners',
      'projects',
    ]) {
      (db as any).run(`DELETE FROM ${table}`);
    }
    __resetRunnerScopeCache();
    __resetDataScopeCache();
    seedProject(db as any, { id: 'px', userId: 'alice', path: '/x' });
    seedProject(db as any, { id: 'py', userId: 'alice', path: '/y' });
    seedThread(db as any, { id: 'tx', projectId: 'px', userId: 'alice' });
    seedThread(db as any, { id: 'ty', projectId: 'py', userId: 'alice' });
    seedThread(
      db as any,
      {
        id: 'ts',
        projectId: null as any,
        userId: 'alice',
        isScratch: 1,
      } as any,
    );
    seedMessage(db as any, { id: 'my', threadId: 'ty' });
    seedRunner(db as any, { id: 'laptop', userId: 'alice', token: 'tok-l', hostname: 'l' });
    seedRunner(db as any, {
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
    seedThread(db as any, { id: 'bob-t', projectId: 'px', userId: 'bob' });
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

  test('user-level settings stay available to dedicated runners', async () => {
    const res = await send('rx', { type: 'data:get_profile', userId: 'alice' });
    expect(res.type).toBe('data:get_profile_response');
  });
});
