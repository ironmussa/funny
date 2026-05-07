import type { ImageAttachment } from '@funny/shared';
import { memo } from 'react';

import { usePromptInputState, type SubmitFn } from '@/hooks/use-prompt-input-state';

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
}

export const PromptInput = memo(function PromptInput({
  onSubmit,
  onStop,
  loading = false,
  running = false,
  queuedCount: queuedCountProp = 0,
  isQueueMode = false,
  placeholder,
  isNewThread = false,
  showBacklog = false,
  projectId: propProjectId,
  initialPrompt: initialPromptProp,
  initialImages: initialImagesProp,
  setPromptRef,
  onContentChange,
  onWorktreeModeChange,
}: PromptInputProps) {
  const state = usePromptInputState({
    onSubmit,
    onContentChange,
    onWorktreeModeChange,
    loading,
    running,
    queuedCountProp,
    isNewThread,
    propProjectId,
    initialPromptProp,
  });

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
        effectiveCwd={state.threadCwd}
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
        loadSkills={state.loadSkillsForEditor}
        setPromptRef={setPromptRef}
        editorRef={state.editorRef}
        editorContainerRef={state.editorContainerRef}
        initialPrompt={initialPromptProp}
        initialImages={initialImagesProp}
        onEditorChange={state.handleEditorChange}
        onEditorPaste={state.handleEditorPaste}
        onCheckoutPreflight={state.handleCheckoutPreflight}
        effort={state.effortOptions.length > 0 ? state.effort : undefined}
        onEffortChange={state.effortOptions.length > 0 ? state.setEffort : undefined}
        effortOptions={state.effortOptions.length > 0 ? state.effortOptions : undefined}
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
