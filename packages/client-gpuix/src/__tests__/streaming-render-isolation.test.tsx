import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { flushSync } from '@gpuix/react';
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing';
import { Profiler } from 'react';

import { PermissionCard, SelectedThreadHeader, ThreadControls } from '../app';
import { createNativeApplicationServices } from '../application';
import { createNativeClientComposition } from '../platform/composition';
import type { NativeHeaders } from '../platform/transport';

const directories: string[] = [];
const noop = () => undefined;

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

describe('native streaming render isolation', () => {
  const nativeTest = hasNativeTestRenderer ? test : test.skip;

  nativeTest('keeps stable controls out of message-only commits', () => {
    const directory = mkdtempSync(join(tmpdir(), 'funny-stream-isolation-'));
    directories.push(directory);
    const composition = createNativeClientComposition({
      dataDirectory: directory,
      persistentSession: false,
      diagnosticSink: () => undefined,
      fetch: async () => ({
        status: 200,
        ok: true,
        headers: new HeadersStub(),
        text: async () => '{}',
      }),
    });
    const application = createNativeApplicationServices(composition);
    application.navigationState
      .getState()
      .replaceProjects([{ id: 'p1', name: 'Project' } as never]);
    application.navigationState
      .getState()
      .replaceProjectThreads('p1', [{ id: 't1', projectId: 'p1', title: 'Thread' } as never]);
    application.workspaceState.getState().replaceInitialPage('t1', {
      messages: [],
      hasMore: false,
    });
    application.workspaceState.getState().setRun('t1', { runId: 'r1', status: 'running' });

    let headerCommits = 0;
    let controlsCommits = 0;
    let permissionCommits = 0;
    const root = createTestRoot({ width: 1440, height: 900 });
    root.render(
      <div>
        <Profiler id="header" onRender={() => headerCommits++}>
          <SelectedThreadHeader
            application={application}
            diagnostics={false}
            filesVisible
            onToggleFiles={noop}
            onToggleRichContent={noop}
            onToggleSidebar={noop}
            richContent
            sidebarVisible
            threadId="t1"
          />
        </Profiler>
        <Profiler id="controls" onRender={() => controlsCommits++}>
          <ThreadControls application={application} threadId="t1" />
        </Profiler>
        <Profiler id="permission" onRender={() => permissionCommits++}>
          <PermissionCard application={application} threadId="t1" />
        </Profiler>
      </div>,
    );
    const mounted = { headerCommits, controlsCommits, permissionCommits };

    flushSync(() => {
      application.workspaceState.getState().applyStreamingDelta({
        eventId: 'stream-1',
        messageId: 'm1',
        threadId: 't1',
        revision: 1,
        content: 'fragment',
        mode: 'replace',
      });
    });
    root.renderer.flush();
    expect({ headerCommits, controlsCommits, permissionCommits }).toEqual(mounted);

    flushSync(() => {
      application.workspaceState.getState().setRun('t1', {
        status: 'waiting',
      });
    });
    root.renderer.flush();
    expect(headerCommits).toBeGreaterThan(mounted.headerCommits);
    expect(controlsCommits).toBeGreaterThan(mounted.controlsCommits);

    flushSync(() => {
      application.workspaceState.getState().setPermission('t1', {
        requestId: 'permission-1',
        runId: 'r1',
        toolName: 'write_file',
        toolInput: '{}',
        requestedAt: 1,
        status: 'active',
      });
    });
    root.renderer.flush();
    expect(permissionCommits).toBeGreaterThan(mounted.permissionCommits);
    application.dispose();
    root.unmount();
  });
});
