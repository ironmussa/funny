import { useLayoutEffect, useRef, useState } from 'react';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { useThreadId } from '@/stores/thread-context';

import type { SubmitFn, ThreadOverride } from './prompt-input-types';
import { usePromptBranches } from './use-prompt-branches';
import { usePromptDictation } from './use-prompt-dictation';
import { usePromptEditorSession } from './use-prompt-input-handlers';
import { usePromptSelection } from './use-prompt-model-state';
import { usePromptQueue } from './use-prompt-queue';
import { usePromptSlashSources } from './use-prompt-slash-sources';
import { usePromptActiveThread, usePromptProjectContext } from './use-prompt-thread-context';

export type { SubmitFn, ThreadOverride } from './prompt-input-types';

interface UsePromptInputStateArgs {
  onSubmit: SubmitFn;
  onContentChange?: (hasContent: boolean, text: string) => void;
  onWorktreeModeChange?: (enabled: boolean) => void;
  onProviderChange?: (provider: string) => void;
  loading: boolean;
  running: boolean;
  queuedCountProp: number;
  queuedNextMessageProp?: string;
  isNewThread: boolean;
  propProjectId?: string;
  initialPromptProp?: string;
  threadOverride?: ThreadOverride;
}

/**
 * Context thread id (single-thread view resolves to activeThread, grid columns
 * to their column-local thread) plus a stable ref to it — used by queue
 * handlers and draft persistence to avoid recreating callbacks on every
 * thread switch.
 */
function useEffectiveThreadId() {
  const effectiveThreadId = useThreadId();
  const threadIdRef = useRef(effectiveThreadId);
  useLayoutEffect(() => {
    threadIdRef.current = effectiveThreadId;
  }, [effectiveThreadId]);
  return { effectiveThreadId, threadIdRef };
}

/**
 * Aggregates the stores/hooks that drive PromptInput — project + active-thread
 * context, model/mode/runtime selection, dictation/PTT, branches, slash
 * sources, queue lifecycle, draft persistence, and submit handlers.
 * PromptInput.tsx imports this single hook instead of wiring all the moving
 * pieces by hand; each concern lives in its own `use-prompt-*` hook.
 */
export function usePromptInputState(args: UsePromptInputStateArgs) {
  const { isNewThread, threadOverride } = args;
  const { effectiveThreadId, threadIdRef } = useEffectiveThreadId();
  const editorRef = useRef<PromptEditorHandle>(null);
  const [sendToBacklog, setSendToBacklog] = useState(false);

  const project = usePromptProjectContext(args);
  const active = usePromptActiveThread(effectiveThreadId, threadOverride);
  const { runtimeState, model, permission } = usePromptSelection({
    isNewThread,
    effectiveThreadId,
    project,
    active,
    onWorktreeModeChange: args.onWorktreeModeChange,
    onProviderChange: args.onProviderChange,
  });

  const dictation = usePromptDictation(editorRef);

  const branches = usePromptBranches({
    isNewThread,
    effectiveProjectId: project.resolvedProjectId,
    selectedProjectId: project.selectedProjectId,
    projects: project.projects,
    activeThreadBaseBranch: active.activeThreadBaseBranch,
  });

  const slash = usePromptSlashSources({
    isNewThread,
    activeThreadWorktreePath: active.activeThreadWorktreePath,
    selectedProjectId: project.selectedProjectId,
    resolvedProjectId: project.resolvedProjectId,
    projects: project.projects,
    provider: model.currentProvider,
    model: model.currentModel,
  });

  const queue = usePromptQueue({
    effectiveThreadId,
    threadIdRef,
    threadOverride,
    queuedCountProp: args.queuedCountProp,
    queuedNextMessageProp: args.queuedNextMessageProp,
  });

  const handlers = usePromptEditorSession({
    editorRef,
    effectiveThreadId,
    threadIdRef,
    stopRecordingRef: dictation.stopRecordingRef,
    initialPromptProp: args.initialPromptProp,
    running: args.running,
    loading: args.loading,
    onSubmit: args.onSubmit,
    onContentChange: args.onContentChange,
  });

  return {
    // Editor refs
    editorRef,
    editorContainerRef: dictation.editorContainerRef,

    // Submission
    wrappedOnSubmit: handlers.wrappedOnSubmit,

    // Queue
    ...queue,

    // Model & mode
    unifiedModel: model.unifiedModel,
    setUnifiedModel: model.setUnifiedModel,
    unifiedModelGroups: model.unifiedModelGroups,
    ...permission,
    ...runtimeState,
    effort: model.effort,
    setEffort: model.setEffort,
    effortOptions: model.effortOptions,

    // Branch
    selectedBranch: branches.selectedBranch,
    followUpBranches: branches.followUpBranches,
    followUpRemoteBranches: branches.followUpRemoteBranches,
    followUpDefaultBranch: branches.followUpDefaultBranch,
    followUpCurrentBranch: branches.followUpCurrentBranch,
    followUpSelectedBranch: branches.followUpSelectedBranch,
    handleFollowUpBranchChange: branches.handleFollowUpBranchChange,
    activeThreadBranch: active.activeThreadBranch,

    // Backlog
    sendToBacklog,
    setSendToBacklog,

    // Dictation
    hasAssemblyaiKey: dictation.hasAssemblyaiKey,
    isRecording: dictation.isRecording,
    isTranscribing: dictation.isTranscribing,
    toggleRecording: dictation.toggleRecording,
    stopRecording: dictation.stopRecording,

    // Editor handlers
    handleEditorChange: handlers.handleEditorChange,
    handleEditorPaste: handlers.handleEditorPaste,
    messageHistory: active.messageHistory,
    handleCheckoutPreflight: branches.handleCheckoutPreflight,
    // `ensureSlashSkills` resolves the (eagerly-loaded) list for the submit
    // path; `slashSkills`/`slashSkillsLoading` feed the editor's `/` menu.
    ...slash,
    sdkSlashCommands: active.sdkSlashCommands,
    // Provider that owns the slash menu: the active thread's provider when
    // viewing one, else the composer's selected provider. Gates Claude-specific
    // built-in command labels so a Codex/GPT thread isn't shown Claude wording.
    slashCommandProvider: active.activeThreadProvider ?? model.currentProvider,

    // Misc
    // Effective cwd: the thread's worktree, else the project directory.
    threadCwd: active.activeThreadWorktreePath || project.projectPath,
    activeThread: active.activeThread,
    activeThreadGitStatus: active.activeThreadGitStatus,
    effectiveProject: project.effectiveProject,
    effectiveProjectId: project.resolvedProjectId,
    effectiveThreadId,
    contextPct: active.contextPct,
    activeThreadContextTokens: active.activeThreadContextTokens,
    contextMaxTokens: active.contextMaxTokens,
    contextBreakdown: active.activeThreadContextBreakdown,
    handleCompact: handlers.handleCompact,

    // Branch-switch dialog (rendered by parent)
    branchSwitchDialog: branches.branchSwitchDialog,
  };
}
