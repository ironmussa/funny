import type { GitStatusInfo, ImageAttachment, QueuedMessage, Thread } from '@funny/shared';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useCodexCommands } from '@/hooks/use-codex-commands';

import { ImageLightbox } from './ImageLightbox';
import type { PromptEditorHandle, PromptSlashResource } from './prompt-editor/PromptEditor';
import { PromptEditor } from './prompt-editor/PromptEditor';
import {
  ImagePreviews,
  TextFilePreviews,
  toLightboxImages,
} from './prompt-input/AttachmentPreviews';
import {
  CompactConfirmDialog,
  PromptBox,
  PromptContextBar,
  PromptInputFrame,
  ProviderSetupPrompt,
} from './prompt-input/PromptChrome';
import { PromptFooterBar } from './prompt-input/PromptFooterBar';
import { PromptToolbar } from './prompt-input/PromptToolbar';
import { QueueIndicator } from './prompt-input/QueueIndicator';
import { TemplateVariableInputs } from './prompt-input/TemplateVariableInputs';
import { useMessageHistory } from './prompt-input/use-message-history';
import { usePromptAttachments } from './prompt-input/use-prompt-attachments';
import { usePromptDrop } from './prompt-input/use-prompt-drop';
import {
  useLightbox,
  usePromptDialogs,
  usePromptEditorBindings,
  useSelectorHandlers,
} from './prompt-input/use-prompt-editor-bindings';
import { usePromptSubmit, type PromptOnSubmit } from './prompt-input/use-prompt-submit';
import { usePromptTemplate } from './prompt-input/use-prompt-template';
import { useQueueEditing } from './prompt-input/use-queue-editing';
import type { ModelSelectGroup } from './PromptSelectors';
export { ModelSelect, type ModelSelectGroup } from './PromptSelectors';

export { formatRemoteUrl, remoteUrlToBrowseUrl } from '@/lib/git-remote-url';

// ── Props ────────────────────────────────────────────────────────

export interface PromptInputUIProps {
  // ── Submission ──
  onSubmit: PromptOnSubmit;
  onStop?: () => void;
  loading?: boolean;
  running?: boolean;

  // ── Queue ──
  queuedCount?: number;
  isQueueMode?: boolean;
  queuedMessages?: QueuedMessage[];
  queueLoading?: boolean;
  onQueueEditSave?: (messageId: string, content: string) => void;
  onQueueDelete?: (messageId: string) => void;

  // ── Mode / Model selectors ──
  unifiedModel: string;
  onUnifiedModelChange: (v: string) => void;
  modelGroups: ModelSelectGroup[];
  mode: string;
  onModeChange: (v: string) => void;
  modes: { value: string; label: string }[];

  // ── Thread context ──
  isNewThread?: boolean;
  /** Scratch threads can't use worktrees — hides the worktree toggle. */
  isScratch?: boolean;
  /**
   * New-thread context bar content (project / repo / branch picker), rendered at
   * the top of the prompt input — next to the worktree switch. Built by the
   * caller so the prompt input stays agnostic of repo/branch data sources.
   */
  newThreadContextBar?: React.ReactNode;
  /** Thread ID (set for follow-up messages). Required to upload files larger than the inline tier. */
  threadId?: string;
  projectId?: string;
  createWorktree?: boolean;
  onCreateWorktreeChange?: (v: boolean) => void;
  runtime?: 'local' | 'remote';
  onRuntimeChange?: (v: 'local' | 'remote') => void;
  hasLauncher?: boolean;

  // ── Branch ──
  selectedBranch?: string;
  followUpBranches?: string[];
  followUpRemoteBranches?: string[];
  followUpDefaultBranch?: string | null;
  followUpSelectedBranch?: string;
  onFollowUpSelectedBranchChange?: (v: string) => void;
  activeThreadBranch?: string | null;

  // ── Git context display ──
  /** Active thread for the powerline bar shown in the prompt footer (follow-up only). */
  powerlineThread?: Thread;
  powerlineProjectName?: string;
  powerlineProjectColor?: string;
  powerlineProjectPath?: string;
  powerlineGitStatus?: GitStatusInfo;
  /** Opens the review pane — wired to the DiffStats chip in the powerline (follow-up only). */
  onOpenReview?: () => void;

  // ── Backlog ──
  showBacklog?: boolean;
  sendToBacklog?: boolean;
  onSendToBacklogChange?: (v: boolean) => void;

  // ── Dictation ──
  hasDictation?: boolean;
  isRecording?: boolean;
  isTranscribing?: boolean;
  onToggleRecording?: () => void;
  onStopRecording?: () => void;

  // ── Editor ──
  placeholder?: string;
  editorCwd?: string;
  /** Resolves the slash skills for the submit path (leading slash-command thread mode). */
  loadSkills?: () => Promise<PromptSlashResource[]>;
  /** Resolved slash skills for the editor's `/` menu (single source of truth). */
  slashSkills?: readonly PromptSlashResource[];
  /** True while {@link slashSkills} is (re)loading. */
  slashSkillsLoading?: boolean;
  /** SDK-reported slash commands for the active thread (names without leading slash) */
  sdkSlashCommands?: string[];
  /** Workflows available in the active project, shown by the `>>` menu. */
  workflows?: readonly { name: string; description?: string; source?: string }[];
  /** True while workflows are being loaded for the `>>` menu. */
  workflowsLoading?: boolean;
  /** Effective provider for the slash menu (gates Claude-specific built-in labels) */
  commandProvider?: string;
  /** Imperative ref — writes setPrompt into it so the parent can restore text */
  setPromptRef?: React.RefObject<((text: string) => void) | null>;
  editorRef?: React.RefObject<PromptEditorHandle | null>;
  /** Ref to the editor container div — used by the parent for PTT focus detection */
  editorContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** User messages available for ↑/↓ navigation in this thread. */
  messageHistory?: readonly string[];
  initialPrompt?: string;
  initialImages?: ImageAttachment[];

  // ── Draft persistence callbacks ──
  onEditorChange?: () => void;
  onEditorPaste?: (e: ClipboardEvent) => void;

  // ── Checkout preflight (new thread local mode) ──
  onCheckoutPreflight?: (branch: string) => Promise<boolean>;

  // ── Effort (Claude-specific) ──
  effort?: string;
  onEffortChange?: (v: string) => void;

  // ── Default template (from project settings) ──
  defaultTemplateId?: string;

  // ── Context window usage (% of total context used) ──
  contextPct?: number;
  contextUsedTokens?: number;
  contextMaxTokens?: number;
  onCompact?: () => void;
}

// ── Component ────────────────────────────────────────────────────

const EMPTY_QUEUED_MESSAGES: QueuedMessage[] = [];
const EMPTY_MESSAGE_HISTORY: string[] = [];

const PROP_DEFAULTS = {
  loading: false,
  running: false,
  queuedCount: 0,
  isQueueMode: false,
  queuedMessages: EMPTY_QUEUED_MESSAGES,
  queueLoading: false,
  isNewThread: false,
  isScratch: false,
  createWorktree: false,
  runtime: 'local' as 'local' | 'remote',
  hasLauncher: false,
  selectedBranch: '',
  followUpSelectedBranch: '',
  showBacklog: false,
  sendToBacklog: false,
  hasDictation: false,
  isRecording: false,
  isTranscribing: false,
  messageHistory: EMPTY_MESSAGE_HISTORY as readonly string[],
};

type ResolvedProps = Omit<PromptInputUIProps, keyof typeof PROP_DEFAULTS> & typeof PROP_DEFAULTS;

/** Applies {@link PROP_DEFAULTS} for every prop that is `undefined` (destructuring-default semantics). */
function withDefaults(props: PromptInputUIProps): ResolvedProps {
  const resolved: Record<string, unknown> = { ...props };
  for (const [key, value] of Object.entries(PROP_DEFAULTS)) {
    if (resolved[key] === undefined) resolved[key] = value;
  }
  return resolved as ResolvedProps;
}

function resolvePlaceholder(
  t: (key: string) => string,
  p: Pick<ResolvedProps, 'placeholder' | 'running' | 'isQueueMode'>,
): string {
  if (!p.running) return p.placeholder ?? t('thread.describeTaskDefault');
  return p.isQueueMode ? t('thread.typeToQueue') : t('thread.typeToInterrupt');
}

/** Which optional controls are visible / enabled. */
function newThreadVisibility(
  p: Pick<ResolvedProps, 'isNewThread' | 'isScratch' | 'showBacklog' | 'loading' | 'running'>,
  isDeepAgent: boolean,
  templateCount: number,
) {
  const deepAgentNew = p.isNewThread && isDeepAgent;
  return {
    contextBar: p.isNewThread && !p.isScratch,
    templateVars: deepAgentNew,
    templates: deepAgentNew && templateCount > 0,
    backlog: p.isNewThread && p.showBacklog,
    fileInputDisabled: p.loading || p.running,
  };
}

function splitUnifiedModel(unifiedModel: string) {
  const [provider, ...rest] = unifiedModel.split(':');
  return { provider, model: rest.join(':') };
}

export const PromptInputUI = memo(function PromptInputUI(rawProps: PromptInputUIProps) {
  const props = withDefaults(rawProps);
  const { isNewThread, loading, running, unifiedModel, mode, modes, onModeChange } = props;
  const { t } = useTranslation();

  const { compactConfirmOpen, setCompactConfirmOpen, needsProviderSetup, setNeedsProviderSetup } =
    usePromptDialogs();
  const lightbox = useLightbox();

  const {
    editorRef,
    editorContainerRef,
    promptBoxRef,
    editorEmpty,
    setEditorEmpty,
    handleEditorChange,
    handlePromptBoxClick,
  } = usePromptEditorBindings(props);

  // ── Provider/model from unified string ──
  const { provider, model } = useMemo(() => splitUnifiedModel(unifiedModel), [unifiedModel]);
  const isDeepAgent = provider === 'deepagent';

  const template = usePromptTemplate({
    defaultTemplateId: props.defaultTemplateId,
    isDeepAgent,
    isNewThread,
  });
  const visible = newThreadVisibility(props, isDeepAgent, template.templates.length);

  const executeCodexCommand = useCodexCommands({
    threadId: props.threadId,
    model,
    mode,
    effort: props.effort,
    running,
    modelGroups: props.modelGroups,
    modes,
    onModelChange: props.onUnifiedModelChange,
    onModeChange,
    onEffortChange: props.onEffortChange,
    onStop: props.onStop,
    onOpenReview: props.onOpenReview,
  });

  const attachments = usePromptAttachments({
    initialImages: props.initialImages,
    provider,
    threadId: props.threadId,
    t,
  });
  const { images, attachedTextFiles } = attachments;

  const handleSubmit = usePromptSubmit({
    ...props,
    t,
    editorRef,
    provider,
    model,
    executeCodexCommand,
    images,
    setImages: attachments.setImages,
    attachedTextFiles,
    setAttachedTextFiles: attachments.setAttachedTextFiles,
    setEditorEmpty: setEditorEmpty,
    setNeedsProviderSetup,
    isDeepAgent,
    selectedTemplateId: template.selectedTemplateId,
    templateVars: template.templateVars,
    templateVarValues: template.templateVarValues,
  });

  const handleHistoryNavigate = useMessageHistory({
    editorRef,
    threadId: props.threadId,
    messageHistory: props.messageHistory,
    onContentChange: handleEditorChange,
  });

  const selectors = useSelectorHandlers({ ...props, editorRef });

  const {
    fileInputRef,
    isDragging,
    endDrag,
    openFilePicker,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileSelect,
    handleEditorPaste,
  } = usePromptDrop({
    editorRef,
    loading,
    addFiles: attachments.addFiles,
    addImageFile: attachments.addImageFile,
    onEditorPaste: props.onEditorPaste,
  });

  const queue = useQueueEditing({
    t,
    onQueueEditSave: props.onQueueEditSave,
    onQueueDelete: props.onQueueDelete,
  });

  // ── Render ──
  return (
    <PromptInputFrame
      isNewThread={isNewThread}
      overlays={
        <>
          <ProviderSetupPrompt
            open={needsProviderSetup}
            provider={provider}
            modelGroups={props.modelGroups}
            projectId={props.projectId}
            onClose={() => setNeedsProviderSetup(false)}
          />
          <CompactConfirmDialog
            open={compactConfirmOpen}
            onOpenChange={setCompactConfirmOpen}
            onCompact={props.onCompact}
          />
        </>
      }
    >
      <ImageLightbox
        images={toLightboxImages(images)}
        initialIndex={lightbox.index}
        open={lightbox.open}
        onClose={lightbox.close}
      />

      <QueueIndicator
        queuedCount={props.queuedCount}
        queuedMessages={props.queuedMessages}
        queueLoading={props.queueLoading}
        queue={queue}
      />

      <PromptContextBar
        show={visible.contextBar}
        createWorktree={props.createWorktree}
        onCreateWorktreeChange={props.onCreateWorktreeChange}
      >
        {props.newThreadContextBar}
      </PromptContextBar>

      <PromptBox
        boxRef={promptBoxRef}
        isDragging={isDragging}
        onClick={handlePromptBoxClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <ImagePreviews
          images={images}
          loading={loading}
          onPreview={lightbox.openAt}
          onRemove={attachments.removeImage}
        />
        <TextFilePreviews
          files={attachedTextFiles}
          loading={loading}
          onRemove={attachments.removeTextFile}
        />

        {/* TipTap Editor */}
        <div ref={editorContainerRef} className="px-3 pt-2">
          <PromptEditor
            ref={editorRef}
            placeholder={resolvePlaceholder(t, props)}
            disabled={loading}
            onSubmit={handleSubmit}
            onCycleMode={selectors.handleCycleMode}
            onHistoryNavigate={handleHistoryNavigate}
            onChange={handleEditorChange}
            onPaste={handleEditorPaste}
            onFileMentionDrop={endDrag}
            cwd={props.editorCwd}
            slashSkills={props.slashSkills}
            slashSkillsLoading={props.slashSkillsLoading}
            sdkSlashCommands={props.sdkSlashCommands}
            workflows={props.workflows}
            workflowsLoading={props.workflowsLoading}
            commandProvider={props.commandProvider}
            containerRef={promptBoxRef}
          />
        </div>
        <TemplateVariableInputs
          show={visible.templateVars}
          variables={template.templateVars}
          values={template.templateVarValues}
          onChange={template.setTemplateVar}
        />
        <input
          ref={fileInputRef}
          data-testid="prompt-file-input"
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
          disabled={visible.fileInputDisabled}
        />
        <PromptToolbar
          unifiedModel={unifiedModel}
          effort={props.effort}
          onUnifiedModelChange={selectors.handleUnifiedModelChange}
          onEffortChange={selectors.handleEffortChange}
          modelGroups={props.modelGroups}
          projectId={props.projectId}
          showTemplates={visible.templates}
          templates={template.templates}
          selectedTemplateId={template.selectedTemplateId}
          onTemplateChange={template.handleTemplateChange}
          mode={mode}
          onModeChange={onModeChange}
          modes={modes}
          showBacklog={visible.backlog}
          sendToBacklog={props.sendToBacklog}
          onSendToBacklogChange={props.onSendToBacklogChange}
          onAttach={openFilePicker}
          hasDictation={props.hasDictation}
          isRecording={props.isRecording}
          isTranscribing={props.isTranscribing}
          onToggleRecording={props.onToggleRecording}
          loading={loading}
          running={running}
          editorEmpty={editorEmpty}
          isQueueMode={props.isQueueMode}
          onStop={props.onStop}
          onSend={handleSubmit}
        />
      </PromptBox>
      <PromptFooterBar
        {...props}
        onRuntimeChange={selectors.handleRuntimeChange}
        onRequestCompact={() => setCompactConfirmOpen(true)}
      />
    </PromptInputFrame>
  );
});
