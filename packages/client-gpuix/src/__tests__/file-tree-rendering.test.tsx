import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileTreeWindowSizeForViewport } from '@funny/gpuix-ui/file-tree';
import { flushSync } from '@gpuix/react';
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing';
import { Profiler } from 'react';

import { NativeFileTreeDock } from '../app';
import { createNativeApplicationServices } from '../application';
import { createNativeClientComposition } from '../platform/composition';
import type { NativeHeaders } from '../platform/transport';

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

describe('native file-tree rendering', () => {
  const nativeTest = hasNativeTestRenderer ? test : test.skip;

  nativeTest('ignores workspace message updates when the selected thread is unchanged', () => {
    const directory = mkdtempSync(join(tmpdir(), 'funny-file-tree-rendering-'));
    directories.push(directory);
    const composition = createNativeClientComposition({
      dataDirectory: directory,
      persistentSession: false,
      diagnosticSink: () => undefined,
      fetch: async () => ({
        status: 200,
        ok: true,
        headers: new HeadersStub(),
        text: async () => JSON.stringify({ files: [], version: 1 }),
      }),
    });
    const application = createNativeApplicationServices(composition);
    const project = { id: 'p1', name: 'Project', path: directory } as never;
    const thread = {
      id: 't1',
      projectId: 'p1',
      title: 'Thread',
      mode: 'local',
      status: 'idle',
    } as never;
    application.navigationState.getState().replaceProjects([project]);
    application.navigationState.getState().replaceProjectThreads('p1', [thread]);
    application.workspaceState.getState().selectThread('t1');
    application.fileTree.state.setState({
      targetKey: `path:${directory}`,
      basePath: directory,
      files: Array.from({ length: 1_000 }, (_, index) => `src/file-${index}.ts`),
      loading: false,
      truncated: false,
      error: null,
      version: 1,
    });

    let renders = 0;
    const root = createTestRoot({ width: 500, height: 800 });
    root.render(
      <Profiler id="file-tree" onRender={() => renders++}>
        <NativeFileTreeDock application={application} viewportHeight={800} />
      </Profiler>,
    );
    const rendersAfterMount = renders;
    expect(root.renderer.findByType('virtual-list')[0]?.children).toHaveLength(
      fileTreeWindowSizeForViewport(800, 1_001),
    );

    flushSync(() => {
      application.workspaceState.getState().replaceInitialPage('t1', {
        messages: [
          {
            id: 'm1',
            threadId: 't1',
            role: 'assistant',
            content: 'Streaming content unrelated to the file tree',
          } as never,
        ],
        hasMore: false,
      });
    });
    root.renderer.flush();

    expect(renders).toBe(rendersAfterMount);
    root.unmount();
    application.dispose();
  });
});
