import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeRendererBenchmarkFixtures } from '@funny/client-benchmark';
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing';

import { GpuixClientApp, THREAD_RETAINED_WINDOW_SIZE } from '../app';
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

describe('native read-only shell', () => {
  const nativeTest = hasNativeTestRenderer ? test : test.skip;

  nativeTest('exposes actionable controls only in diagnostic mode', () => {
    const directory = mkdtempSync(join(tmpdir(), 'funny-native-diagnostics-'));
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
    application.authState.getState().authenticate({
      id: 'u1',
      username: 'ada',
      displayName: 'Ada',
      role: 'user',
    });
    application.navigationState
      .getState()
      .replaceProjects([{ id: 'p1', name: 'Project' } as never]);
    application.navigationState
      .getState()
      .replaceProjectThreads('p1', [{ id: 't1', projectId: 'p1', title: 'Diagnostics' } as never]);
    application.workspaceState.getState().selectThread('t1');
    application.workspaceState.getState().replaceInitialPage('t1', {
      messages: [
        {
          id: 'm1',
          threadId: 't1',
          role: 'assistant',
          content: 'Ready',
        } as never,
      ],
      hasMore: false,
    });
    application.statusState.setState({ phase: 'ready', error: null });
    const resetFrameStats = mock(() => undefined);
    const root = createTestRoot({ width: 1440, height: 900 });
    root.render(
      <GpuixClientApp application={application} diagnostics onResetFrameStats={resetFrameStats} />,
    );

    const toggle = root.renderer.findByTestId('rich-content-toggle');
    const reset = root.renderer.findByTestId('frame-stats-reset');
    expect(toggle).toBeDefined();
    expect(reset).toBeDefined();
    expect(root.renderer.findByText('Rendering: Rich')).toBeDefined();
    const toggleBounds = root.renderer.getElementBounds(toggle!.id)!;
    root.renderer.nativeSimulateClick(
      toggleBounds[0]! + toggleBounds[2]! / 2,
      toggleBounds[1]! + toggleBounds[3]! / 2,
    );
    expect(root.renderer.findByText('Rendering: Fast')).toBeDefined();
    const resetBounds = root.renderer.getElementBounds(reset!.id)!;
    root.renderer.nativeSimulateClick(
      resetBounds[0]! + resetBounds[2]! / 2,
      resetBounds[1]! + resetBounds[3]! / 2,
    );
    expect(resetFrameStats).toHaveBeenCalledTimes(1);

    root.render(<GpuixClientApp application={application} />);
    expect(root.renderer.findByTestId('rich-content-toggle')).toBeUndefined();
    expect(root.renderer.findByTestId('frame-stats-reset')).toBeUndefined();
    application.dispose();
    root.unmount();
  });

  nativeTest('keeps window lifecycle active while focus moves between child controls', () => {
    const directory = mkdtempSync(join(tmpdir(), 'funny-native-focus-'));
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
    application.statusState.setState({ phase: 'ready', error: null });
    application.authState.getState().becomeAnonymous();
    const snapshots: Array<{ focused: boolean; visible: boolean }> = [];
    const unsubscribe = composition.lifecycle.subscribe((snapshot) => snapshots.push(snapshot));
    const root = createTestRoot();
    root.render(<GpuixClientApp application={application} />);

    const inputs = root.renderer.findByType('input');
    expect(inputs).toHaveLength(2);
    root.renderer.focusElement(inputs[0]!.id);
    root.renderer.flush();
    root.renderer.focusElement(inputs[1]!.id);
    root.renderer.flush();

    expect(composition.lifecycle.current()).toEqual({
      focused: true,
      visible: true,
    });
    expect(snapshots).toEqual([]);
    unsubscribe();
    application.dispose();
    root.unmount();
  });

  nativeTest('virtualizes both navigation and the canonical 500-message inventory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'funny-native-shell-'));
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
    const fixture = makeRendererBenchmarkFixtures().a;
    application.authState.getState().authenticate({
      id: 'u1',
      username: 'ada',
      displayName: 'Ada',
      role: 'user',
    });
    application.navigationState
      .getState()
      .replaceProjects([{ id: 'p1', name: 'Project' } as never]);
    application.navigationState.getState().replaceProjectThreads('p1', [
      {
        id: fixture.threadId,
        projectId: 'p1',
        title: 'Long thread',
        status: 'idle',
      } as never,
    ]);
    application.workspaceState.getState().selectThread(fixture.threadId);
    application.gitStatusState.getState().replace([
      {
        threadId: fixture.threadId,
        branchKey: 'project:p1:branch:main',
        state: 'dirty',
        dirtyFileCount: 3,
        unpushedCommitCount: 0,
        unpulledCommitCount: 0,
        hasRemoteBranch: true,
        isMergedIntoBase: false,
        linesAdded: 24,
        linesDeleted: 7,
      },
    ]);
    application.workspaceState.getState().replaceInitialPage(fixture.threadId, {
      messages: fixture.messages as never,
      hasMore: false,
      total: fixture.counts.messages,
      windowStart: 0,
    });
    application.workspaceState.getState().upsertToolCall(fixture.threadId, {
      id: 'large-output',
      messageId: fixture.messages.at(-1)?.id,
      name: 'Large result',
      input: '{}',
      output: `${'x'.repeat(1_000_000)}tail-marker`,
    } as never);
    const root = createTestRoot();
    root.render(<GpuixClientApp application={application} />);
    const virtualLists = root.renderer.findByType('virtual-list');
    expect(virtualLists).toHaveLength(2);
    expect(virtualLists[0]!.children.length).toBeGreaterThan(2);
    expect(virtualLists[1]!.children).toHaveLength(THREAD_RETAINED_WINDOW_SIZE);
    const sidebarBounds = root.renderer.getElementBounds(virtualLists[0]!.id);
    expect(sidebarBounds?.[2]).toBeGreaterThan(0);
    expect(sidebarBounds?.[3]).toBeGreaterThan(0);
    expect(root.renderer.findByType('markdown')).toHaveLength(0);
    expect(root.renderer.findByType('code')).toHaveLength(0);
    expect(root.renderer.getPaintedText()).toContain('Long thread');
    expect(root.renderer.findByTestId('navigation-diff-summary')).not.toBeNull();
    expect(root.renderer.findByTestId('files-diff-summary')).not.toBeNull();
    expect(root.renderer.getPaintedText()).toContain('+24');
    expect(root.renderer.getPaintedText()).toContain('characters hidden');
    expect(root.renderer.getPaintedText()).not.toContain('tail-marker');
    application.dispose();
    root.unmount();
  });
});
