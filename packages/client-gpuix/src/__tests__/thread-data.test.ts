import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAuthSessionStore,
  createThreadNavigationStore,
  createThreadWorkspaceStore,
} from '@funny/client-core';

import { createNativeGitStatusStore } from '../git-status-state';
import { createNativeClientComposition } from '../platform/composition';
import type { NativeHeaders } from '../platform/transport';
import { NativeAuthService } from '../services/auth';
import { NativeThreadDataService } from '../services/thread-data';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class HeadersStub implements NativeHeaders {
  get(): string | null {
    return null;
  }
  forEach(): void {}
}

const project = { id: 'p1', name: 'Project' };
const thread = { id: 't1', projectId: 'p1', title: 'Thread', status: 'idle' };
const message = (id: string) => ({
  id,
  threadId: 't1',
  role: 'assistant',
  content: id,
  timestamp: '2026-08-23T00:00:00Z',
});

function setup(statusForThread = 200) {
  const directory = mkdtempSync(join(tmpdir(), 'funny-thread-data-'));
  directories.push(directory);
  const requests: string[] = [];
  const composition = createNativeClientComposition({
    dataDirectory: directory,
    persistentSession: false,
    diagnosticSink: () => undefined,
    fetch: async (url) => {
      const path = new URL(url).pathname + new URL(url).search;
      requests.push(path);
      let body: unknown = {};
      let status = 200;
      if (path === '/api/projects') body = [project];
      else if (path.startsWith('/api/threads?projectId='))
        body = { threads: [thread], total: 1, hasMore: false };
      else if (path.startsWith('/api/threads/scratch'))
        body = { threads: [], total: 0, hasMore: false };
      else if (path === '/api/threads/shared-with-me') body = { threads: [] };
      else if (path.startsWith('/api/git/status'))
        body = {
          statuses: [
            {
              threadId: 't1',
              branchKey: 'p1:feature',
              state: 'dirty',
              dirtyFileCount: 2,
              unpushedCommitCount: 0,
              unpulledCommitCount: 0,
              hasRemoteBranch: false,
              isMergedIntoBase: false,
              linesAdded: 14,
              linesDeleted: 3,
            },
          ],
        };
      else if (path.startsWith('/api/browse/files/index'))
        body = {
          files: ['src/app.ts', 'README.md'],
          version: 1,
          basePath: '/repo',
        };
      else if (path.startsWith('/api/threads/t1/messages'))
        body = { messages: [message('m0')], hasMore: false };
      else if (path.startsWith('/api/threads/t1')) {
        status = statusForThread;
        body =
          status === 200
            ? {
                ...thread,
                messages: [message('m1'), message('m2')],
                hasMore: true,
                total: 3,
                windowStart: 1,
              }
            : { error: 'Forbidden' };
      }
      return {
        status,
        ok: status < 300,
        headers: new HeadersStub(),
        text: async () => JSON.stringify(body),
      };
    },
  });
  const authState = createAuthSessionStore();
  const navigation = createThreadNavigationStore();
  const workspace = createThreadWorkspaceStore();
  const gitStatus = createNativeGitStatusStore();
  const auth = new NativeAuthService({
    platform: composition.platform,
    cookies: composition.cookies,
    state: authState,
    clientOrigin: composition.clientOrigin,
  });
  const data = new NativeThreadDataService({
    composition,
    auth,
    authState,
    navigation,
    workspace,
    gitStatus,
  });
  return { data, navigation, workspace, gitStatus, composition, requests };
}

describe('native thread data', () => {
  test('loads grouped navigation, selected history, and older pages', async () => {
    const { data, navigation, workspace, composition, requests } = setup();
    await data.loadNavigation();
    expect(requests).toContain('/api/git/status?projectId=p1');
    expect(navigation.getState()).toMatchObject({
      projectIds: ['p1'],
      threadIdsByProject: { p1: ['t1'] },
    });
    expect(await data.selectThread('t1')).toBe(true);
    expect(workspace.getState().byThreadId.t1.messageIds).toEqual(['m1', 'm2']);
    expect(composition.navigation.current().pathname).toBe('/projects/p1/threads/t1');
    expect(await data.loadOlder('t1')).toBe(true);
    expect(workspace.getState().byThreadId.t1.messageIds).toEqual(['m0', 'm1', 'm2']);
  });

  test('keeps access-denied state visible and retryable', async () => {
    const { data, workspace } = setup(403);
    expect(await data.selectThread('t1')).toBe(false);
    expect(workspace.getState().byThreadId.t1.error).toBe('Access denied');
  });

  test('loads aggregate git status without coupling it to navigation', async () => {
    const { data, gitStatus } = setup();
    await data.loadProjectGitStatus('p1');
    expect(gitStatus.getState().byThreadId.t1).toMatchObject({
      dirtyFileCount: 2,
      linesAdded: 14,
      linesDeleted: 3,
    });
  });
});
