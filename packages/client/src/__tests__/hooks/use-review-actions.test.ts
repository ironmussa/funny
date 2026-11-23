import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type { FileDiffSummary } from '@funny/shared';
import { act, renderHook } from '@testing-library/react';
import { err, ok } from 'neverthrow';

// Bun runs each client test file in its own module registry (`bun test --parallel`
// implies `--isolate`), so these mock.module calls do not leak into sibling files.
const { gitApi, threadsApi, browseApi, toast, toastErrorFn, getThreadById, remoteActions } =
  (() => ({
    gitApi: {
      revertFiles: vi.fn(),
      projectRevertFiles: vi.fn(),
      addPatternsToGitignore: vi.fn(),
      projectAddPatternsToGitignore: vi.fn(),
      addToGitignore: vi.fn(),
      projectAddToGitignore: vi.fn(),
      resetSoft: vi.fn(),
      projectResetSoft: vi.fn(),
      stageFiles: vi.fn(),
      projectStageFiles: vi.fn(),
      unstageFiles: vi.fn(),
      projectUnstageFiles: vi.fn(),
      stagePatch: vi.fn(),
      projectStagePatch: vi.fn(),
      resolveConflict: vi.fn(),
      projectResolveConflict: vi.fn(),
      stash: vi.fn(),
      projectStash: vi.fn(),
    },
    threadsApi: { sendMessage: vi.fn() },
    browseApi: { openInEditor: vi.fn(), openDirectory: vi.fn() },
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
    toastErrorFn: vi.fn(),
    getThreadById: vi.fn(),
    remoteActions: vi.fn(),
  }))();

// `t` echoes the key plus the interpolated message so assertions can tell
// which outcome (success / failure key) the hook chose.
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) =>
      opts && typeof opts === 'object' && 'message' in opts
        ? `${key}:${(opts as { message: string }).message}`
        : key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
mock.module('sonner', () => ({ toast }));
mock.module('@/lib/toast-error', () => ({ toastError: toastErrorFn }));
mock.module('@/lib/api/git', () => ({ gitApi }));
mock.module('@/lib/api/threads', () => ({ threadsApi }));
mock.module('@/lib/api/browse', () => ({ browseApi }));
mock.module('@/stores/thread-context', () => ({ getThreadById }));
mock.module('@/hooks/use-git-remote-actions', () => ({
  useGitRemoteActions: (opts: unknown) => {
    remoteActions(opts);
    return {
      pullInProgress: false,
      fetchInProgress: false,
      pullStrategyDialog: { open: false, errorMessage: '' },
      setPullStrategyDialog: vi.fn(),
      handlePull: vi.fn(),
      handlePullStrategyChosen: vi.fn(),
      handleFetchOrigin: vi.fn(),
    };
  },
}));

import { useReviewActions } from '@/hooks/use-review-actions';
import { useSettingsStore } from '@/stores/settings-store';

type Args = Parameters<typeof useReviewActions>[0];

function file(path: string, staged = false): FileDiffSummary {
  return { path, status: 'modified', staged };
}

function makeArgs(overrides: Partial<Args> = {}): Args {
  return {
    hasGitContext: true,
    effectiveThreadId: 't1',
    projectModeId: null,
    summaries: [],
    checkedFiles: new Set<string>(),
    expandedFile: null,
    selectedFile: null,
    baseBranch: 'main',
    basePath: '/repo',
    refresh: vi.fn(async () => {}),
    loadDiffForFile: vi.fn(async () => {}),
    setDiffCache: vi.fn(),
    setHasRebaseConflict: vi.fn(),
    setConfirmDialog: vi.fn(),
    refreshStashList: vi.fn(async () => {}),
    ...overrides,
  };
}

function setup(overrides: Partial<Args> = {}) {
  const args = makeArgs(overrides);
  const hook = renderHook(() => useReviewActions(args));
  return { args, result: hook.result };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const apiError = (message: string) => err({ type: 'INTERNAL', message });

beforeEach(() => {
  vi.clearAllMocks();
  Object.values(gitApi).forEach((fn) => fn.mockResolvedValue(ok({})));
  gitApi.resolveConflict.mockResolvedValue(ok({ remainingConflicts: 0 }));
  gitApi.projectResolveConflict.mockResolvedValue(ok({ remainingConflicts: 0 }));
  threadsApi.sendMessage.mockResolvedValue(ok({}));
  browseApi.openDirectory.mockResolvedValue(ok({}));
});

describe('useReviewActions', () => {
  describe('revert / discard', () => {
    test('executeRevert in a thread reverts through the thread API, toasts and refreshes', async () => {
      const { args, result } = setup();
      await act(() => result.current.executeRevert('src/a.ts'));

      expect(gitApi.revertFiles).toHaveBeenCalledWith('t1', ['src/a.ts']);
      expect(gitApi.projectRevertFiles).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('review.revertSuccess');
      expect(args.refresh).toHaveBeenCalledTimes(1);
    });

    test('executeRevert in project mode uses the project API', async () => {
      const { result } = setup({ effectiveThreadId: undefined, projectModeId: 'p1' });
      await act(() => result.current.executeRevert('a.ts'));

      expect(gitApi.projectRevertFiles).toHaveBeenCalledWith('p1', ['a.ts']);
      expect(gitApi.revertFiles).not.toHaveBeenCalled();
    });

    test('a failed revert shows the error message and does not refresh', async () => {
      gitApi.revertFiles.mockResolvedValue(apiError('locked'));
      const { args, result } = setup();
      await act(() => result.current.executeDiscardAll(['a.ts', 'b.ts']));

      expect(toast.error).toHaveBeenCalledWith('review.revertFailed:locked');
      expect(toast.success).not.toHaveBeenCalled();
      expect(args.refresh).not.toHaveBeenCalled();
    });

    test('handleDiscardAll asks to confirm the checked files, else every changed file, else nothing', () => {
      const withChecked = setup({
        summaries: [file('a.ts'), file('b.ts')],
        checkedFiles: new Set(['b.ts']),
      });
      act(() => withChecked.result.current.handleDiscardAll());
      expect(withChecked.args.setConfirmDialog).toHaveBeenCalledWith({
        type: 'discard-all',
        paths: ['b.ts'],
      });

      const all = setup({ summaries: [file('a.ts'), file('b.ts')] });
      act(() => all.result.current.handleDiscardAll());
      expect(all.args.setConfirmDialog).toHaveBeenCalledWith({
        type: 'discard-all',
        paths: ['a.ts', 'b.ts'],
      });

      const empty = setup();
      act(() => empty.result.current.handleDiscardAll());
      expect(empty.args.setConfirmDialog).not.toHaveBeenCalled();
    });

    test('handleDiscardFolder only takes files inside the folder, not a sibling with the same prefix', () => {
      const { args, result } = setup({
        summaries: [file('src/a.ts'), file('src/sub/b.ts'), file('src2/c.ts'), file('src')],
      });
      act(() => result.current.handleDiscardFolder('src'));

      expect(args.setConfirmDialog).toHaveBeenCalledWith({
        type: 'discard-all',
        paths: ['src/a.ts', 'src/sub/b.ts'],
      });
    });
  });

  test('without a git context no action reaches the API', async () => {
    const { args, result } = setup({ hasGitContext: false, summaries: [file('a.ts')] });
    await act(async () => {
      await result.current.executeRevert('a.ts');
      await result.current.executeDiscardAll(['a.ts']);
      await result.current.executeIgnoreFiles(['a.ts']);
      await result.current.handleIgnore('*.log');
      await result.current.executeResetSoft();
      await result.current.handleStageFile('a.ts');
      await result.current.handleUnstageFile('a.ts');
      await result.current.handleStageSelected();
      await result.current.handleUnstageAll();
      await result.current.handleStagePatch('patch');
      await result.current.handleStash();
      await result.current.handleStashSelected();
    });

    for (const fn of Object.values(gitApi)) expect(fn).not.toHaveBeenCalled();
    expect(args.refresh).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  describe('staging', () => {
    test('handleStageSelected stages only the checked files that are not staged yet', async () => {
      const { args, result } = setup({
        summaries: [file('a.ts'), file('b.ts', true), file('c.ts')],
        checkedFiles: new Set(['a.ts', 'b.ts', 'gone.ts']),
      });
      await act(() => result.current.handleStageSelected());

      expect(gitApi.stageFiles).toHaveBeenCalledWith('t1', ['a.ts']);
      expect(args.refresh).toHaveBeenCalledTimes(1);
    });

    test('handleStageSelected with nothing to stage says so instead of calling the API', async () => {
      const { args, result } = setup({ summaries: [file('a.ts', true)] });
      await act(() => result.current.handleStageSelected());

      expect(gitApi.stageFiles).not.toHaveBeenCalled();
      expect(toast.info).toHaveBeenCalledWith('review.allAlreadyStaged');
      expect(args.refresh).not.toHaveBeenCalled();
    });

    test('handleUnstageAll without a selection unstages every staged file in project mode', async () => {
      const { result } = setup({
        effectiveThreadId: undefined,
        projectModeId: 'p1',
        summaries: [file('a.ts', true), file('b.ts'), file('c.ts', true)],
      });
      await act(() => result.current.handleUnstageAll());

      expect(gitApi.projectUnstageFiles).toHaveBeenCalledWith('p1', ['a.ts', 'c.ts']);
    });

    test('a failed stage toasts the failure and leaves the status alone', async () => {
      gitApi.stageFiles.mockResolvedValue(apiError('nope'));
      const { args, result } = setup();
      await act(() => result.current.handleStageFile('a.ts'));

      expect(toast.error).toHaveBeenCalledWith('review.stageFailed');
      expect(args.refresh).not.toHaveBeenCalled();
    });

    test('handleStagePatch flags the patch as staging while the request runs', async () => {
      const pending = deferred<unknown>();
      gitApi.stagePatch.mockReturnValueOnce(pending.promise);
      const { args, result } = setup();

      let run!: Promise<void>;
      act(() => {
        run = result.current.handleStagePatch('diff --git');
      });
      expect(result.current.patchStagingInProgress).toBe(true);

      await act(async () => {
        pending.resolve(ok({}));
        await run;
      });
      expect(result.current.patchStagingInProgress).toBe(false);
      expect(gitApi.stagePatch).toHaveBeenCalledWith('t1', 'diff --git');
      expect(args.refresh).toHaveBeenCalledTimes(1);
    });

    test('a failed patch clears the flag and reports the error through toastError', async () => {
      const error = { type: 'INTERNAL', message: 'patch does not apply' };
      gitApi.stagePatch.mockResolvedValue(err(error));
      const { args, result } = setup();
      await act(() => result.current.handleStagePatch('diff'));

      expect(result.current.patchStagingInProgress).toBe(false);
      expect(toastErrorFn).toHaveBeenCalledWith(error, 'review.stageFailed');
      expect(args.refresh).not.toHaveBeenCalled();
    });

    test('handleSelectionStateChange keeps the same map when the state did not change', () => {
      const { result } = setup();
      act(() => result.current.handleSelectionStateChange('a.ts', 'partial'));
      const first = result.current.fileSelectionState;
      expect(first.get('a.ts')).toBe('partial');

      act(() => result.current.handleSelectionStateChange('a.ts', 'partial'));
      expect(result.current.fileSelectionState).toBe(first);

      act(() => result.current.handleSelectionStateChange('a.ts', 'all'));
      expect(result.current.fileSelectionState.get('a.ts')).toBe('all');
    });
  });

  describe('stash and reset (in-flight guard)', () => {
    test('a second stash while the first is running is ignored', async () => {
      const pending = deferred<unknown>();
      gitApi.stash.mockReturnValueOnce(pending.promise);
      const { args, result } = setup();

      let first!: Promise<void>;
      act(() => {
        first = result.current.handleStash();
      });
      expect(result.current.stashInProgress).toBe(true);

      // The re-rendered handler sees the in-flight flag, as a second click would.
      await act(() => result.current.handleStash());
      expect(gitApi.stash).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve(ok({}));
        await first;
      });
      expect(result.current.stashInProgress).toBe(false);
      expect(toast.success).toHaveBeenCalledWith('review.stashSuccess');
      expect(args.refresh).toHaveBeenCalledTimes(1);
      expect(args.refreshStashList).toHaveBeenCalledTimes(1);
    });

    test('a failed stash still clears the flag and refreshes status and stash list', async () => {
      gitApi.stash.mockResolvedValue(apiError('conflict'));
      const { args, result } = setup();
      await act(() => result.current.handleStash());

      expect(toast.error).toHaveBeenCalledWith('review.stashFailed:conflict');
      expect(result.current.stashInProgress).toBe(false);
      expect(args.refresh).toHaveBeenCalledTimes(1);
      expect(args.refreshStashList).toHaveBeenCalledTimes(1);
    });

    test('handleStashSelected stashes the checked paths, and does nothing with no files', async () => {
      const checked = setup({
        summaries: [file('a.ts'), file('b.ts')],
        checkedFiles: new Set(['b.ts']),
      });
      await act(() => checked.result.current.handleStashSelected());
      expect(gitApi.stash).toHaveBeenCalledWith('t1', ['b.ts']);

      gitApi.stash.mockClear();
      const empty = setup();
      await act(() => empty.result.current.handleStashSelected());
      expect(gitApi.stash).not.toHaveBeenCalled();
      expect(empty.args.refresh).not.toHaveBeenCalled();
    });

    test('a second soft reset while one is running is ignored; failure still clears the flag', async () => {
      const pending = deferred<unknown>();
      gitApi.projectResetSoft.mockReturnValueOnce(pending.promise);
      const { args, result } = setup({ effectiveThreadId: undefined, projectModeId: 'p1' });

      let first!: Promise<void>;
      act(() => {
        first = result.current.executeResetSoft();
      });
      expect(result.current.resetInProgress).toBe(true);
      await act(() => result.current.executeResetSoft());
      expect(gitApi.projectResetSoft).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve(apiError('no commits'));
        await first;
      });
      expect(toast.error).toHaveBeenCalledWith('review.resetSoftFailed:no commits');
      expect(result.current.resetInProgress).toBe(false);
      expect(args.refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('ignore', () => {
    test('executeIgnoreFiles adds the paths to .gitignore and refreshes; failure does not refresh', async () => {
      const { args, result } = setup();
      await act(() => result.current.executeIgnoreFiles(['dist', 'tmp']));
      expect(gitApi.addPatternsToGitignore).toHaveBeenCalledWith('t1', ['dist', 'tmp']);
      expect(toast.success).toHaveBeenCalledWith('2 path(s) added to .gitignore');
      expect(args.refresh).toHaveBeenCalledTimes(1);

      gitApi.addToGitignore.mockResolvedValue(apiError('read-only'));
      await act(() => result.current.handleIgnore('*.log'));
      expect(gitApi.addToGitignore).toHaveBeenCalledWith('t1', '*.log');
      expect(toast.error).toHaveBeenCalledWith('review.ignoreFailed:read-only');
      expect(args.refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('conflict resolution', () => {
    test('resolving a block drops the cached diff, reloads it and refreshes', async () => {
      gitApi.resolveConflict.mockResolvedValue(ok({ remainingConflicts: 2 }));
      const { args, result } = setup({ expandedFile: 'src/a.ts', selectedFile: 'other.ts' });
      await act(() => result.current.handleResolveConflict(0, 'theirs'));

      expect(gitApi.resolveConflict).toHaveBeenCalledWith('t1', 'src/a.ts', 0, 'theirs');
      expect(toast.success).toHaveBeenCalledWith('Conflict 1 resolved (incoming) — 2 remaining');

      const updater = (args.setDiffCache as ReturnType<typeof vi.fn>).mock.calls[0][0] as (
        m: Map<string, string>,
      ) => Map<string, string>;
      const before = new Map([
        ['src/a.ts', 'old'],
        ['b.ts', 'keep'],
      ]);
      const after = updater(before);
      expect([...after.keys()]).toEqual(['b.ts']);
      expect(before.has('src/a.ts')).toBe(true);

      expect(args.loadDiffForFile).toHaveBeenCalledWith('src/a.ts');
      expect(args.refresh).toHaveBeenCalledTimes(1);
    });

    test('with no open file nothing is resolved; a failure leaves the cache alone', async () => {
      const none = setup();
      await act(() => none.result.current.handleResolveConflict(0, 'ours'));
      expect(gitApi.resolveConflict).not.toHaveBeenCalled();

      gitApi.projectResolveConflict.mockResolvedValue(apiError('bad block'));
      const failing = setup({
        effectiveThreadId: undefined,
        projectModeId: 'p1',
        selectedFile: 'a.ts',
      });
      await act(() => failing.result.current.handleResolveConflict(3, 'both'));
      expect(gitApi.projectResolveConflict).toHaveBeenCalledWith('p1', 'a.ts', 3, 'both');
      expect(toast.error).toHaveBeenCalledWith('Failed to resolve conflict: bad block');
      expect(failing.args.setDiffCache).not.toHaveBeenCalled();
      expect(failing.args.loadDiffForFile).not.toHaveBeenCalled();
      expect(failing.args.refresh).not.toHaveBeenCalled();
    });

    test('asking the agent sends the resolve prompt with the tool permissions and clears the conflict', async () => {
      useSettingsStore.setState({
        toolPermissions: { Read: 'allow', Bash: 'deny', Edit: 'ask' } as never,
      });
      const { args, result } = setup({ baseBranch: 'develop' });
      await act(() => result.current.handleAskAgentResolve());

      expect(threadsApi.sendMessage).toHaveBeenCalledWith('t1', 'review.agentResolvePrompt', {
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
      });
      expect(toast.success).toHaveBeenCalledWith('review.agentResolveSent');
      expect(args.setHasRebaseConflict).toHaveBeenCalledWith(false);
    });

    test('a failed agent request keeps the conflict banner; no thread sends nothing', async () => {
      const error = { type: 'INTERNAL', message: 'runner offline' };
      threadsApi.sendMessage.mockResolvedValue(err(error));
      const { args, result } = setup();
      await act(() => result.current.handleAskAgentResolve());
      expect(toastErrorFn).toHaveBeenCalledWith(error);
      expect(args.setHasRebaseConflict).not.toHaveBeenCalled();

      threadsApi.sendMessage.mockClear();
      const project = setup({ effectiveThreadId: undefined, projectModeId: 'p1' });
      await act(() => project.result.current.handleAskAgentResolve());
      expect(threadsApi.sendMessage).not.toHaveBeenCalled();
    });

    test("open-in-editor uses the thread's worktree and the default editor, and skips without one", () => {
      useSettingsStore.setState({ defaultEditor: 'vscode' as never });
      getThreadById.mockReturnValue({ worktreePath: '/wt/t1' });
      const { result } = setup();
      act(() => result.current.handleOpenInEditorConflict());
      expect(getThreadById).toHaveBeenCalledWith('t1');
      expect(browseApi.openInEditor).toHaveBeenCalledWith('/wt/t1', 'vscode');

      browseApi.openInEditor.mockClear();
      getThreadById.mockReturnValue({ worktreePath: undefined });
      act(() => result.current.handleOpenInEditorConflict());
      expect(browseApi.openInEditor).not.toHaveBeenCalled();
    });
  });

  test('pull / fetch are delegated with the same target and the refresh callback', () => {
    const { args } = setup({ effectiveThreadId: undefined, projectModeId: 'p1' });
    expect(remoteActions).toHaveBeenLastCalledWith({
      threadId: undefined,
      projectId: 'p1',
      hasGitContext: true,
      afterChange: args.refresh,
    });
  });

  describe('filesystem', () => {
    test('handleCopyPath copies the relative or the absolute path', () => {
      const writeText = vi.fn();
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      const { result } = setup({ basePath: '/repo' });

      act(() => result.current.handleCopyPath('src/a.ts', true));
      act(() => result.current.handleCopyPath('src/a.ts', false));

      expect(writeText.mock.calls).toEqual([['src/a.ts'], ['/repo/src/a.ts']]);
      expect(toast.success).toHaveBeenCalledWith('review.pathCopied');
    });

    test("handleOpenDirectory opens a file's folder, the root for a top-level file, or the folder itself", async () => {
      const { result } = setup({ basePath: '/repo' });
      await act(async () => {
        await result.current.handleOpenDirectory('src/lib/a.ts', true);
        await result.current.handleOpenDirectory('README.md', true);
        await result.current.handleOpenDirectory('src/lib', false);
      });

      expect(browseApi.openDirectory.mock.calls).toEqual([
        [{ path: '/repo/src/lib' }],
        [{ path: '/repo' }],
        [{ path: '/repo/src/lib' }],
      ]);
    });

    test('handleOpenDirectory reports a failure and does nothing without a base path', async () => {
      browseApi.openDirectory.mockResolvedValue(apiError('no such dir'));
      const { result } = setup();
      await act(() => result.current.handleOpenDirectory('a.ts', true));
      expect(toast.error).toHaveBeenCalledWith('review.openDirectoryError', {
        description: 'no such dir',
      });

      browseApi.openDirectory.mockClear();
      const noBase = setup({ basePath: undefined });
      await act(() => noBase.result.current.handleOpenDirectory('a.ts', true));
      expect(browseApi.openDirectory).not.toHaveBeenCalled();
    });
  });
});
