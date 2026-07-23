import type { ImageAttachment } from '@funny/shared';
import { memo, useCallback } from 'react';

import {
  usePromptInputState,
  type SubmitFn,
  type ThreadOverride,
} from '@/hooks/use-prompt-input-state';
import { useUIStore } from '@/stores/ui-store';

import { PromptInputUI } from './PromptInputUI';

interface PromptInputProps {
  onSubmit: SubmitFn;
  onStop?: () => void;
  loading?: boolean;
  running?: boolean;
  queuedCount?: number;
  queuedNextMessage?: string;
  isQueueMode?: boolean;
  placeholder?: string;
  isNewThread?: boolean;
  isScratch?: boolean;
  /** New-thread context bar content (project / repo / branch), rendered at the top of the input. */
  newThreadContextBar?: React.ReactNode;
  showBacklog?: boolean;
  projectId?: string;
  initialPrompt?: string;
  initialImages?: ImageAttachment[];
  /** Imperative ref — PromptInput writes setPrompt into it so the parent can restore text */
  setPromptRef?: React.RefObject<((text: string) => void) | null>;
  /** Called when the editor content changes — reports whether it has content and the current text */
  onContentChange?: (hasContent: boolean, text: string) => void;
  /** Called when the worktree mode toggle changes */
  onWorktreeModeChange?: (enabled: boolean) => void;
  /** Called when the selected model's provider changes */
  onProviderChange?: (provider: string) => void;
  /** Override thread data (for live columns where the thread is not the activeThread) */
  threadOverride?: ThreadOverride;
}

export const PromptInput = memo(function PromptInput({
  onSubmit,
  onStop,
  loading = false,
  running = false,
  queuedCount: queuedCountProp = 0,
  queuedNextMessage: queuedNextMessageProp,
  isQueueMode = false,
  placeholder,
  isNewThread = false,
  isScratch = false,
  newThreadContextBar,
  showBacklog = false,
  projectId: propProjectId,
  initialPrompt: initialPromptProp,
  initialImages: initialImagesProp,
  setPromptRef,
  onContentChange,
  onWorktreeModeChange,
  onProviderChange,
  threadOverride,
}: PromptInputProps) {
  const state = usePromptInputState({
    onSubmit,
    onContentChange,
    onWorktreeModeChange,
    loading,
    running,
    queuedCountProp,
    queuedNextMessageProp,
    isNewThread,
    propProjectId,
    initialPromptProp,
    threadOverride,
    onProviderChange,
  });

  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const handleOpenReview = useCallback(() => {
    setReviewPaneOpen(true);
  }, [setReviewPaneOpen]);

  return (
    <>
      <PromptInputUI
        onSubmit={state.wrappedOnSubmit}
        onStop={onStop}
        loading={loading}
        running={running}
        queuedCount={state.queuedCount}
        isQueueMode={isQueueMode}
        queuedMessages={state.queuedMessages}
        queueLoading={state.queueLoading}
        onQueueEditSave={state.handleQueueEditSave}
        onQueueDelete={state.handleQueueDelete}
        unifiedModel={state.unifiedModel}
        onUnifiedModelChange={state.setUnifiedModel}
        modelGroups={state.unifiedModelGroups}
        mode={state.mode}
        onModeChange={state.setMode}
        modes={state.modes}
        isNewThread={isNewThread}
        isScratch={isScratch}
        newThreadContextBar={newThreadContextBar}
        threadId={state.effectiveThreadId}
        createWorktree={state.createWorktree}
        onCreateWorktreeChange={state.setCreateWorktree}
        runtime={state.runtime}
        onRuntimeChange={state.setRuntime}
        hasLauncher={state.hasLauncher}
        selectedBranch={state.selectedBranch}
        followUpBranches={state.followUpBranches}
        followUpRemoteBranches={state.followUpRemoteBranches}
        followUpDefaultBranch={state.followUpDefaultBranch}
        followUpSelectedBranch={state.followUpSelectedBranch}
        onFollowUpSelectedBranchChange={state.handleFollowUpBranchChange}
        activeThreadBranch={state.activeThreadBranch ?? state.followUpCurrentBranch ?? undefined}
        powerlineThread={state.activeThread ?? undefined}
        powerlineProjectName={state.effectiveProject?.name}
        powerlineProjectColor={state.effectiveProject?.color}
        powerlineProjectPath={state.effectiveProject?.path}
        powerlineGitStatus={state.activeThreadGitStatus}
        onOpenReview={handleOpenReview}
        showBacklog={showBacklog}
        sendToBacklog={state.sendToBacklog}
        onSendToBacklogChange={state.setSendToBacklog}
        hasDictation={state.hasAssemblyaiKey}
        isRecording={state.isRecording}
        isTranscribing={state.isTranscribing}
        onToggleRecording={state.toggleRecording}
        onStopRecording={state.stopRecording}
        placeholder={placeholder}
        editorCwd={state.threadCwd}
        loadSkills={state.ensureSlashSkills}
        slashSkills={state.slashSkills}
        slashSkillsLoading={state.slashSkillsLoading}
        sdkSlashCommands={state.sdkSlashCommands}
        workflows={state.workflowSuggestions}
        workflowsLoading={state.workflowSuggestionsLoading}
        commandProvider={state.slashCommandProvider}
        setPromptRef={setPromptRef}
        editorRef={state.editorRef}
        editorContainerRef={state.editorContainerRef}
        messageHistory={state.messageHistory}
        initialPrompt={initialPromptProp}
        initialImages={initialImagesProp}
        onEditorChange={state.handleEditorChange}
        onEditorPaste={state.handleEditorPaste}
        onCheckoutPreflight={state.handleCheckoutPreflight}
        effort={state.effort}
        onEffortChange={state.setEffort}
        defaultTemplateId={state.effectiveProject?.defaultAgentTemplateId}
        contextPct={state.contextPct}
        contextUsedTokens={state.activeThreadContextTokens}
        contextMaxTokens={state.contextMaxTokens}
        onCompact={state.effectiveThreadId ? state.handleCompact : undefined}
      />

      {state.branchSwitchDialog}
    </>
  );
});
