import type {
  AgentTemplate,
  GitStatusInfo,
  ImageAttachment,
  QueuedMessage,
  Thread,
} from '@funny/shared';
import { getAttachmentLimits } from '@funny/shared/models';
import {
  ArrowUp,
  Square,
  Loader2,
  Paperclip,
  Mic,
  MicOff,
  X,
  Inbox,
  ListOrdered,
  Pencil,
  Trash2,
  Check,
  Bot,
  ChevronDown,
} from 'lucide-react';
import { useState, useRef, useCallback, useMemo, memo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { AttachmentChip } from '@/components/ui/chip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { threadsApi } from '@/lib/api/threads';
import { dragHasFileMention, readFileMentionDragData } from '@/lib/file-mention-dnd';
import { getEffortLevels, parseUnifiedModel } from '@/lib/providers';
import { getLeadingSlashCommand, resolveSlashCommandThreadMode } from '@/lib/thread-payload';
import { cn } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';

import { ImageLightbox } from './ImageLightbox';
import type { PromptEditorHandle, PromptSlashResource } from './prompt-editor/PromptEditor';
import { PromptEditor } from './prompt-editor/PromptEditor';
import { serializeEditorContent } from './prompt-editor/serialize';
import { ContextUsageRing } from './thread/ContextUsageRing';
import { ThreadPowerline } from './ThreadPowerline';

// ── Selectors ────────────────────────────────────────────────────

export const ModeSelect = memo(function ModeSelect({
  value,
  onChange,
  modes,
}: {
  value: string;
  onChange: (v: string) => void;
  modes: { value: string; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        data-testid="prompt-mode-select"
        tabIndex={-1}
        size="xs"
        className="w-auto border-none bg-transparent shadow-none"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent side="top" align="start">
        {modes.map((m) => (
          <SelectItem key={m.value} value={m.value} size="xs">
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});

export type ModelSelectGroup = {
  provider: string;
  providerLabel: string;
  models: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  disabledReason?: 'not-installed' | 'no-runner';
};

/**
 * Combined model + thinking-effort picker. Selecting a model that supports
 * reasoning effort opens a submenu of thinking modes; picking a mode sets the
 * model AND the effort in one action, and both are reflected in the trigger
 * copy (e.g. "Opus 4.8 · High"). Models without effort support are plain items.
 */
export const ModelSelect = memo(function ModelSelect({
  value,
  effort,
  onChange,
  onEffortChange,
  groups,
}: {
  value: string;
  effort?: string;
  onChange: (v: string) => void;
  onEffortChange?: (v: string) => void;
  groups: ModelSelectGroup[];
}) {
  const selectedGroup = groups.find((g) => g.models.some((m) => m.value === value));
  const selected = selectedGroup?.models.find((m) => m.value === value);
  const { provider: selProvider, model: selModel } = parseUnifiedModel(value);
  const selEffortLabel = getEffortLevels(selModel, selProvider).find(
    (e) => e.value === effort,
  )?.label;

  // Leading slot keeps labels aligned whether or not a row shows a checkmark.
  const lead = (active: boolean) => (
    <span className="flex w-3 shrink-0 items-center justify-center">
      {active && <Check className="icon-2xs" />}
    </span>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="prompt-model-select"
        tabIndex={-1}
        className="text-foreground hover:bg-accent/50 focus-visible:ring-ring/50 flex h-7 w-auto cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs focus-visible:ring-1 focus-visible:outline-hidden"
      >
        <span className="text-muted-foreground shrink-0">
          {selectedGroup?.providerLabel ?? selProvider}
        </span>
        <span className="text-muted-foreground shrink-0">·</span>
        <span className="truncate">{selected?.label ?? selModel}</span>
        {selEffortLabel && <span className="text-muted-foreground">· {selEffortLabel}</span>}
        <ChevronDown className="icon-xs opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        collisionPadding={8}
        size="xs"
        className="min-w-44"
      >
        {groups.map((group, idx) => (
          <DropdownMenuGroup key={group.provider}>
            {idx > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel
              className={group.disabled ? 'text-muted-foreground/60' : undefined}
              data-testid={group.disabled ? `model-group-disabled-${group.provider}` : undefined}
            >
              {group.providerLabel}
              {group.disabledReason === 'no-runner' && (
                <span className="ml-1 font-normal italic">— connect a runner</span>
              )}
              {group.disabledReason === 'not-installed' && (
                <span className="ml-1 font-normal italic">— not installed on runner</span>
              )}
            </DropdownMenuLabel>
            {group.models.map((m) => {
              const isSelected = m.value === value;
              const { model: mModel } = parseUnifiedModel(m.value);
              const efforts = m.disabled ? [] : getEffortLevels(mModel, group.provider);

              if (efforts.length > 0 && onEffortChange) {
                return (
                  <DropdownMenuSub key={m.value}>
                    <DropdownMenuSubTrigger
                      size="xs"
                      data-testid={`prompt-model-option-${m.value}`}
                    >
                      {lead(isSelected)}
                      <span className="truncate">{m.label}</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent size="xs">
                      {efforts.map((e) => (
                        <DropdownMenuItem
                          key={e.value}
                          size="xs"
                          data-testid={`prompt-effort-option-${m.value}-${e.value}`}
                          onSelect={() => {
                            onChange(m.value);
                            onEffortChange(e.value);
                          }}
                        >
                          {lead(isSelected && effort === e.value)}
                          <span title={e.description}>{e.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              }

              return (
                <DropdownMenuItem
                  key={m.value}
                  size="xs"
                  disabled={m.disabled}
                  data-testid={`prompt-model-option-${m.value}`}
                  onSelect={() => onChange(m.value)}
                >
                  {lead(isSelected)}
                  <span className="truncate">{m.label}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

export const TemplateSelect = memo(function TemplateSelect({
  value,
  onChange,
  templates,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  templates: AgentTemplate[];
}) {
  const userTemplates = templates.filter((t) => !t.id.startsWith('__builtin__') && !t.shared);
  const sharedTemplates = templates.filter((t) => !t.id.startsWith('__builtin__') && t.shared);
  const builtinTemplates = templates.filter((t) => t.id.startsWith('__builtin__'));

  const renderItem = (tpl: AgentTemplate) => (
    <SelectItem key={tpl.id} value={tpl.id} size="xs">
      <span className="flex items-center gap-1.5">
        {tpl.color && (
          <span
            className="inline-block size-2 shrink-0 rounded-full"
            style={{ backgroundColor: tpl.color }}
          />
        )}
        <span className="truncate">{tpl.name}</span>
        {tpl.model && (
          <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 text-[9px]">
            {tpl.model}
          </span>
        )}
      </span>
      {tpl.description && (
        <span className="text-muted-foreground block truncate pl-3.5 text-[10px]">
          {tpl.description}
        </span>
      )}
    </SelectItem>
  );

  return (
    <Select
      value={value ?? '__none__'}
      onValueChange={(v) => onChange(v === '__none__' ? undefined : v)}
    >
      <SelectTrigger
        data-testid="prompt-template-select"
        tabIndex={-1}
        size="xs"
        className="w-auto border-none bg-transparent shadow-none"
      >
        <span className="flex items-center gap-1">
          <Bot className="icon-xs" />
          <SelectValue placeholder="Template" />
        </span>
      </SelectTrigger>
      <SelectContent side="top" align="start">
        <SelectItem value="__none__" size="xs">
          No template
        </SelectItem>
        {userTemplates.length > 0 && (
          <SelectGroup>
            <SelectSeparator />
            <SelectLabel className="text-[10px]">My Templates</SelectLabel>
            {userTemplates.map(renderItem)}
          </SelectGroup>
        )}
        {sharedTemplates.length > 0 && (
          <SelectGroup>
            <SelectSeparator />
            <SelectLabel className="text-[10px]">Shared</SelectLabel>
            {sharedTemplates.map(renderItem)}
          </SelectGroup>
        )}
        {builtinTemplates.length > 0 && (
          <SelectGroup>
            <SelectSeparator />
            <SelectLabel className="text-[10px]">Built-in</SelectLabel>
            {builtinTemplates.map(renderItem)}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
});

export { formatRemoteUrl, remoteUrlToBrowseUrl } from '@/lib/git-remote-url';

// ── Props ────────────────────────────────────────────────────────

export interface PromptInputUIProps {
  // ── Submission ──
  onSubmit: (
    prompt: string,
    opts: {
      provider?: string;
      model: string;
      mode: string;
      effort?: string;
      threadMode?: string;
      runtime?: string;
      baseBranch?: string;
      cwd?: string;
      sendToBacklog?: boolean;
      fileReferences?: { path: string; type?: 'file' | 'folder' }[];
      symbolReferences?: {
        path: string;
        name: string;
        kind: string;
        line: number;
        endLine?: number;
      }[];
      agentTemplateId?: string;
      templateVariables?: Record<string, string>;
    },
    images?: ImageAttachment[],
  ) => Promise<boolean | void> | boolean | void;
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
  /** Effective provider for the slash menu (gates Claude-specific built-in labels) */
  commandProvider?: string;
  /** Imperative ref — writes setPrompt into it so the parent can restore text */
  setPromptRef?: React.RefObject<((text: string) => void) | null>;
  editorRef?: React.RefObject<PromptEditorHandle | null>;
  /** Ref to the editor container div — used by the parent for PTT focus detection */
  editorContainerRef?: React.RefObject<HTMLDivElement | null>;
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

const RUNTIME_MODES = [
  { value: 'local', label: 'Local' },
  { value: 'remote', label: 'Remote' },
];

export const PromptInputUI = memo(function PromptInputUI({
  onSubmit,
  onStop,
  loading = false,
  running = false,
  queuedCount = 0,
  isQueueMode = false,
  queuedMessages: queuedMessagesProp = [],
  queueLoading = false,
  onQueueEditSave,
  onQueueDelete,
  unifiedModel,
  onUnifiedModelChange,
  modelGroups,
  mode,
  onModeChange,
  modes,
  isNewThread = false,
  isScratch = false,
  newThreadContextBar,
  threadId,
  createWorktree = false,
  onCreateWorktreeChange,
  runtime = 'local',
  onRuntimeChange,
  hasLauncher = false,
  selectedBranch = '',
  followUpSelectedBranch = '',
  powerlineThread,
  powerlineProjectName,
  powerlineProjectColor,
  powerlineProjectPath,
  powerlineGitStatus,
  onOpenReview,
  showBacklog = false,
  sendToBacklog = false,
  onSendToBacklogChange,
  hasDictation = false,
  isRecording = false,
  isTranscribing = false,
  onToggleRecording,
  onStopRecording,
  placeholder,
  editorCwd,
  loadSkills,
  slashSkills,
  slashSkillsLoading,
  sdkSlashCommands,
  commandProvider,
  setPromptRef,
  editorRef: externalEditorRef,
  editorContainerRef: externalEditorContainerRef,
  initialPrompt: _initialPrompt,
  initialImages,
  onEditorChange,
  onEditorPaste,
  onCheckoutPreflight,
  effort,
  onEffortChange,
  defaultTemplateId,
  contextPct,
  contextUsedTokens,
  contextMaxTokens,
  onCompact,
}: PromptInputUIProps) {
  const { t } = useTranslation();

  // ── Internal refs ──
  const internalEditorRef = useRef<PromptEditorHandle>(null);
  const editorRef = externalEditorRef ?? internalEditorRef;
  const internalEditorContainerRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = externalEditorContainerRef ?? internalEditorContainerRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptBoxRef = useRef<HTMLDivElement>(null);

  // ── Local UI state ──
  const [images, setImages] = useState<ImageAttachment[]>(initialImages ?? []);
  // Compaction is irreversible (older messages get summarized), so confirm first.
  const [compactConfirmOpen, setCompactConfirmOpen] = useState(false);
  /**
   * Attached files: small files are inlined (`mode: 'inline'`, content is
   * embedded in the prompt on submit); larger files are uploaded to the
   * runner (`mode: 'upload'`, sent as a fileReference for the server to
   * resolve on disk). `uploading: true` marks an upload in flight.
   */
  const [attachedTextFiles, setAttachedTextFiles] = useState<
    Array<
      | { mode: 'inline'; name: string; content: string; size: number }
      | { mode: 'upload'; name: string; path: string; size: number }
      | { mode: 'uploading'; name: string; size: number }
    >
  >([]);
  const [editorEmpty, setEditorEmpty] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  // ── Queue editing state ──
  const [editingQueuedMessageId, setEditingQueuedMessageId] = useState<string | null>(null);
  const [editingQueuedMessageContent, setEditingQueuedMessageContent] = useState('');
  const [queueActionMessageId, setQueueActionMessageId] = useState<string | null>(null);

  // ── Expose setPrompt to parent ──
  if (setPromptRef) {
    setPromptRef.current = (text: string) => {
      editorRef.current?.setContent(text);
    };
  }

  // ── Agent template (Deep Agent only) ──
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>(
    defaultTemplateId,
  );
  const [templateVarValues, setTemplateVarValues] = useState<Record<string, string>>({});
  const { templates, initialized: templatesLoaded, loadTemplates } = useAgentTemplateStore();
  const selectedTemplate = useMemo(
    () => (selectedTemplateId ? templates.find((t) => t.id === selectedTemplateId) : undefined),
    [selectedTemplateId, templates],
  );
  const templateVars = selectedTemplate?.variables ?? [];

  // ── Provider/model from unified string ──
  const provider = useMemo(() => unifiedModel.split(':')[0], [unifiedModel]);
  const model = useMemo(() => unifiedModel.split(':').slice(1).join(':'), [unifiedModel]);

  // Load templates when provider is deepagent and creating a new thread
  const isDeepAgent = provider === 'deepagent';
  useEffect(() => {
    if (isDeepAgent && isNewThread && !templatesLoaded) loadTemplates();
  }, [isDeepAgent, isNewThread, templatesLoaded, loadTemplates]);

  // ── Submit handler ──
  const handleSubmit = useCallback(async () => {
    if (loading) return;
    if (isRecording && onStopRecording) onStopRecording();

    const editorJSON = editorRef.current?.getJSON();
    const isEmpty = editorRef.current?.isEmpty() ?? true;
    if (isEmpty) {
      toast.warning(t('prompt.emptyPrompt', 'Please enter a prompt before sending'));
      return;
    }

    const serialized = editorJSON
      ? serializeEditorContent(editorJSON)
      : { text: '', fileReferences: [], symbolReferences: [] };
    const leadingSlashCommand = getLeadingSlashCommand(serialized.text);
    const slashResources = leadingSlashCommand && loadSkills ? await loadSkills() : undefined;
    const commandThreadMode =
      isNewThread && !isScratch && leadingSlashCommand && slashResources
        ? resolveSlashCommandThreadMode(serialized.text, slashResources)
        : undefined;
    const effectiveThreadMode =
      commandThreadMode ?? (createWorktree ? ('worktree' as const) : ('local' as const));
    const effectiveCreateWorktree = effectiveThreadMode === 'worktree';

    // Checkout preflight for local mode
    if (isNewThread && !effectiveCreateWorktree && onCheckoutPreflight && selectedBranch) {
      const canProceed = await onCheckoutPreflight(selectedBranch);
      if (!canProceed) return;
    }

    // Block submit while any upload is still in flight.
    if (attachedTextFiles.some((f) => f.mode === 'uploading')) {
      toast.warning(
        t('prompt.uploadInProgress', {
          defaultValue: 'Wait for uploads to finish before sending.',
        }),
      );
      return;
    }

    // Inline-tier files: embed contents in a <referenced-files> block prepended
    // to the prompt (browsers can't expose paths for these small dropped files).
    const inlineFiles = attachedTextFiles.filter(
      (f): f is Extract<typeof f, { mode: 'inline' }> => f.mode === 'inline',
    );
    const inlineFilesBlock =
      inlineFiles.length > 0
        ? `<referenced-files>\n${inlineFiles
            .map((f) => `<file path="${f.name.replace(/"/g, '&quot;')}">\n${f.content}\n</file>`)
            .join('\n')}\n</referenced-files>\n\n`
        : '';
    const submittedPrompt = inlineFilesBlock + serialized.text;
    const submittedImages = images.length > 0 ? images : undefined;
    // Upload-tier files: send their on-disk path as a fileReference so the
    // server can resolve them via augmentPromptWithFiles (which falls back to
    // a "use Read tool" note when the file exceeds the inline cap).
    const uploadedRefs = attachedTextFiles
      .filter((f): f is Extract<typeof f, { mode: 'upload' }> => f.mode === 'upload')
      .map((f) => ({ path: f.path, type: 'file' as const }));
    const mergedFileRefs = [...serialized.fileReferences, ...uploadedRefs];
    const submittedFiles = mergedFileRefs.length > 0 ? mergedFileRefs : undefined;
    const submittedSymbols =
      serialized.symbolReferences.length > 0 ? serialized.symbolReferences : undefined;
    const submittedTextFiles = attachedTextFiles;
    editorRef.current?.clear();
    setImages([]);
    setAttachedTextFiles([]);
    setEditorEmpty(true);
    editorRef.current?.focus();

    const result = await onSubmit(
      submittedPrompt,
      {
        provider,
        model,
        mode,
        effort,
        ...(isNewThread
          ? {
              threadMode: effectiveThreadMode,
              runtime,
              baseBranch: selectedBranch || undefined,
              sendToBacklog,
              agentTemplateId: isDeepAgent ? selectedTemplateId : undefined,
              templateVariables:
                isDeepAgent && selectedTemplateId && templateVars.length > 0
                  ? Object.fromEntries(
                      templateVars.map((v) => [
                        v.name,
                        templateVarValues[v.name] || v.defaultValue || '',
                      ]),
                    )
                  : undefined,
            }
          : { baseBranch: followUpSelectedBranch || undefined }),
        fileReferences: submittedFiles,
        symbolReferences: submittedSymbols,
      },
      submittedImages,
    );
    if (result === false) {
      if (editorJSON) editorRef.current?.setContent(editorJSON);
      setImages(submittedImages ?? []);
      setAttachedTextFiles(submittedTextFiles);
    }
  }, [
    loading,
    isRecording,
    onStopRecording,
    images,
    attachedTextFiles,
    t,
    isNewThread,
    isScratch,
    createWorktree,
    loadSkills,
    onCheckoutPreflight,
    selectedBranch,
    onSubmit,
    provider,
    model,
    mode,
    effort,
    runtime,
    sendToBacklog,
    followUpSelectedBranch,
    editorRef,
    isDeepAgent,
    selectedTemplateId,
  ]);

  // ── Editor callbacks ──
  const handleEditorChange = useCallback(() => {
    setEditorEmpty(editorRef.current?.isEmpty() ?? true);
    onEditorChange?.();
  }, [onEditorChange, editorRef]);

  const handleTemplateChange = useCallback((v: string | undefined) => {
    setSelectedTemplateId(v);
    setTemplateVarValues({});
  }, []);

  const handleRuntimeChange = useCallback(
    (v: string) => onRuntimeChange?.(v as 'local' | 'remote'),
    [onRuntimeChange],
  );

  // Return focus to the editor after picking a model — Radix Select restores
  // focus to its trigger on close, so defer past that to land the caret in the
  // editor and let the user keep typing.
  const handleUnifiedModelChange = useCallback(
    (v: string) => {
      onUnifiedModelChange(v);
      requestAnimationFrame(() => editorRef.current?.focus());
    },
    [onUnifiedModelChange, editorRef],
  );

  const handleEffortChange = useCallback(
    (v: string) => {
      onEffortChange?.(v);
      requestAnimationFrame(() => editorRef.current?.focus());
    },
    [onEffortChange, editorRef],
  );

  const handleCycleMode = useCallback(() => {
    onModeChange(
      (() => {
        const idx = modes.findIndex((m) => m.value === mode);
        return modes[(idx + 1) % modes.length].value;
      })(),
    );
  }, [modes, mode, onModeChange]);

  // ── Image handling ──
  const addImageFile = useCallback(async (file: File): Promise<void> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        const mediaType = file.type as ImageAttachment['source']['media_type'];
        setImages((prev) => [
          ...prev,
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
        ]);
        resolve();
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Browsers do not expose absolute paths for dropped files, so we cannot
  // send a path the runtime can resolve. Instead we use a tiered strategy:
  //   - inline (size ≤ inlineMaxBytes): read contents and embed in prompt.
  //   - upload (size ≤ uploadMaxBytes): POST to /threads/:id/upload, which
  //     writes the file under .funny/uploads/<threadId>/ on the runner; we
  //     then send the path as a fileReference and the agent reads on demand.
  //   - reject (size > uploadMaxBytes): toast error.
  //
  // Limits per provider live in PROVIDER_ATTACHMENT_LIMITS (@funny/shared/models).
  const attachmentLimits = useMemo(
    () => getAttachmentLimits(provider as Parameters<typeof getAttachmentLimits>[0]),
    [provider],
  );

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const idx = dataUrl.indexOf(',');
        resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
      };
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsDataURL(file);
    });

  const addTextFile = useCallback(
    async (file: File): Promise<void> => {
      const { inlineMaxBytes, uploadMaxBytes } = attachmentLimits;

      // Reject: above the upload tier.
      if (file.size > uploadMaxBytes) {
        toast.error(
          t('prompt.fileTooLarge', {
            defaultValue: '{{name}} is too large ({{size}} MB). Max {{max}} MB.',
            name: file.name,
            size: (file.size / (1024 * 1024)).toFixed(1),
            max: (uploadMaxBytes / (1024 * 1024)).toFixed(0),
          }),
        );
        return;
      }

      // Inline tier: small enough to embed directly in the prompt.
      if (file.size <= inlineMaxBytes) {
        try {
          const content = await file.text();
          setAttachedTextFiles((prev) => [
            ...prev,
            { mode: 'inline', name: file.name, content, size: file.size },
          ]);
        } catch {
          toast.error(
            t('prompt.fileReadError', {
              defaultValue: 'Could not read {{name}}',
              name: file.name,
            }),
          );
        }
        return;
      }

      // Upload tier: requires an existing thread (path is `.funny/uploads/<threadId>/`).
      if (!threadId) {
        toast.error(
          t('prompt.fileUploadNeedsThread', {
            defaultValue:
              '{{name}} is too large to inline. Send a first message to start the thread, then attach larger files.',
            name: file.name,
          }),
        );
        return;
      }

      // Optimistically add a "uploading" chip so the user sees progress.
      const tempKey = `${file.name}__${Date.now()}__${Math.random()}`;
      setAttachedTextFiles((prev) => [
        ...prev,
        { mode: 'uploading', name: tempKey, size: file.size },
      ]);
      try {
        const contentBase64 = await fileToBase64(file);
        const result = await threadsApi.uploadFile(threadId, {
          provider,
          filename: file.name,
          contentBase64,
        });
        if (result.isErr()) {
          setAttachedTextFiles((prev) =>
            prev.filter((f) => !(f.mode === 'uploading' && f.name === tempKey)),
          );
          toast.error(
            t('prompt.fileUploadError', {
              defaultValue: 'Upload failed for {{name}}: {{error}}',
              name: file.name,
              error: result.error.message,
            }),
          );
          return;
        }
        const uploaded = result.value;
        setAttachedTextFiles((prev) =>
          prev.map((f) =>
            f.mode === 'uploading' && f.name === tempKey
              ? {
                  mode: 'upload',
                  name: file.name,
                  path: uploaded.path,
                  size: uploaded.size,
                }
              : f,
          ),
        );
      } catch (e) {
        setAttachedTextFiles((prev) =>
          prev.filter((f) => !(f.mode === 'uploading' && f.name === tempKey)),
        );
        toast.error(
          t('prompt.fileUploadError', {
            defaultValue: 'Upload failed for {{name}}: {{error}}',
            name: file.name,
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    },
    [attachmentLimits, provider, t, threadId],
  );

  const removeTextFile = useCallback((index: number) => {
    setAttachedTextFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleEditorPaste = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) addImageFile(file);
        }
      }
      onEditorPaste?.(e);
    },
    [addImageFile, onEditorPaste],
  );

  // ── Drag & Drop ──
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files') || dragHasFileMention(e.dataTransfer)) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (loading) return;

    const mention = readFileMentionDragData(e.dataTransfer);
    if (mention) {
      editorRef.current?.insertFileMention(mention.path, mention.fileType);
      editorRef.current?.focus();
      return;
    }

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        await addImageFile(file);
      } else {
        await addTextFile(file);
      }
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        await addImageFile(file);
      } else {
        await addTextFile(file);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── Queue handlers ──
  const handleQueueEditStart = useCallback((message: QueuedMessage) => {
    setEditingQueuedMessageId(message.id);
    setEditingQueuedMessageContent(message.content);
  }, []);

  const handleQueueEditCancel = useCallback(() => {
    setEditingQueuedMessageId(null);
    setEditingQueuedMessageContent('');
  }, []);

  const handleQueueEditSave = useCallback(
    (messageId: string) => {
      const nextContent = editingQueuedMessageContent.trim();
      if (!nextContent) {
        toast.warning(t('prompt.emptyPrompt', 'Please enter a prompt before sending'));
        return;
      }
      setQueueActionMessageId(messageId);
      onQueueEditSave?.(messageId, editingQueuedMessageContent);
      setEditingQueuedMessageId(null);
      setEditingQueuedMessageContent('');
      setQueueActionMessageId((current) => (current === messageId ? null : current));
    },
    [editingQueuedMessageContent, onQueueEditSave, t],
  );

  const handleQueueDelete = useCallback(
    (messageId: string) => {
      setQueueActionMessageId(messageId);
      onQueueDelete?.(messageId);
      if (editingQueuedMessageId === messageId) {
        setEditingQueuedMessageId(null);
        setEditingQueuedMessageContent('');
      }
      setQueueActionMessageId((current) => (current === messageId ? null : current));
    },
    [editingQueuedMessageId, onQueueDelete],
  );

  // ── Derived values ──
  const defaultPlaceholder = placeholder ?? t('thread.describeTaskDefault');
  const editorPlaceholder = running
    ? isQueueMode
      ? t('thread.typeToQueue')
      : t('thread.typeToInterrupt')
    : defaultPlaceholder;

  // ── Click-to-focus: click anywhere on the prompt box (except interactive elements) to focus editor ──
  const handlePromptBoxClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      // Don't steal focus from interactive elements
      if (
        target.closest(
          'button, a, input, select, textarea, [role="switch"], [role="combobox"], [role="listbox"], [role="option"], [data-radix-popper-content-wrapper]',
        )
      ) {
        return;
      }
      editorRef.current?.focus();
    },
    [editorRef],
  );

  // ── Render ──
  return (
    <div className={cn(!isNewThread && 'px-3 sm:px-4')}>
      <div className={cn('mx-auto w-full max-w-3xl min-w-0', isNewThread ? 'pb-0' : 'pb-4')}>
        {/* Image lightbox */}
        <ImageLightbox
          images={images.map((img, idx) => ({
            src: `data:${img.source.media_type};base64,${img.source.data}`,
            alt: `Attachment ${idx + 1}`,
          }))}
          initialIndex={lightboxIndex}
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
        />

        {/* Queue indicator */}
        {(queuedCount > 0 || queuedMessagesProp.length > 0) && (
          <div
            data-testid="queue-indicator"
            className="border-border/40 mb-2 space-y-2 rounded-md border px-2.5 py-2"
          >
            <div className="flex items-center gap-1.5">
              <ListOrdered className="icon-xs text-muted-foreground shrink-0" />
              <span className="text-muted-foreground text-xs">
                {(queuedMessagesProp.length > 0 ? queuedMessagesProp.length : queuedCount) === 1
                  ? t('prompt.queuedOne', '1 message in queue')
                  : t('prompt.queuedMany', '{{count}} messages in queue', {
                      count:
                        queuedMessagesProp.length > 0 ? queuedMessagesProp.length : queuedCount,
                    })}
              </span>
            </div>

            {queueLoading && queuedMessagesProp.length === 0 ? (
              <div className="border-border/60 bg-background/60 text-muted-foreground flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
                <Loader2 className="icon-xs animate-spin" />
                {t('prompt.loadingQueuedMessages', 'Loading queued messages...')}
              </div>
            ) : (
              <div className="divide-border divide-y *:bg-transparent">
                {queuedMessagesProp.map((message, index) => {
                  const isEditing = editingQueuedMessageId === message.id;
                  const isBusy = queueActionMessageId === message.id;
                  const isPreviewOnly = message.id.startsWith('preview-queued-message:');

                  return (
                    <div
                      key={message.id}
                      data-testid={`queue-item-${message.id}`}
                      className="bg-transparent px-1 py-1 first:pt-0 last:pb-0"
                    >
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground shrink-0 text-[10px] font-medium tracking-wide uppercase">
                            #{index + 1}
                          </span>
                          <Input
                            data-testid={`queue-edit-textarea-${message.id}`}
                            value={editingQueuedMessageContent}
                            onChange={(event) => setEditingQueuedMessageContent(event.target.value)}
                            disabled={isBusy}
                            className="bg-background h-7 flex-1 text-xs"
                          />
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  data-testid={`queue-save-${message.id}`}
                                  type="button"
                                  size="icon-xs"
                                  onClick={() => handleQueueEditSave(message.id)}
                                  disabled={isBusy}
                                  aria-label={t('prompt.saveQueuedMessage', 'Save')}
                                  className="text-muted-foreground hover:text-foreground"
                                >
                                  {isBusy ? (
                                    <Loader2 className="icon-xs animate-spin" />
                                  ) : (
                                    <Check className="icon-xs" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {t('prompt.saveQueuedMessage', 'Save')}
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  data-testid={`queue-cancel-edit-${message.id}`}
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={handleQueueEditCancel}
                                  disabled={isBusy}
                                  aria-label={t('prompt.cancelQueuedEdit', 'Cancel')}
                                  className="text-muted-foreground hover:text-foreground"
                                >
                                  <X className="icon-xs" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {t('prompt.cancelQueuedEdit', 'Cancel')}
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground shrink-0 text-[10px] font-medium tracking-wide uppercase">
                            #{index + 1}
                          </span>
                          <p
                            className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
                            title={message.content}
                          >
                            {message.content}
                          </p>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  data-testid={`queue-edit-${message.id}`}
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={() => handleQueueEditStart(message)}
                                  disabled={isBusy || isPreviewOnly}
                                  aria-label={t('prompt.editQueuedMessage', 'Edit')}
                                  className="text-muted-foreground hover:text-foreground"
                                >
                                  <Pencil className="icon-xs" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {t('prompt.editQueuedMessage', 'Edit')}
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  data-testid={`queue-delete-${message.id}`}
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={() => handleQueueDelete(message.id)}
                                  disabled={isBusy || isPreviewOnly}
                                  aria-label={t('prompt.deleteQueuedMessage', 'Delete')}
                                  className="text-destructive hover:text-destructive"
                                >
                                  {isBusy ? (
                                    <Loader2 className="icon-xs animate-spin" />
                                  ) : (
                                    <Trash2 className="icon-xs" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {t('prompt.deleteQueuedMessage', 'Delete')}
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Top context bar — project / repo / branch + worktree switch. Sits
            visually OUTSIDE the bordered prompt box (new threads only). */}
        {isNewThread && !isScratch && (
          <div
            className="text-muted-foreground mb-3 flex items-center gap-2 px-1 text-sm"
            data-testid="new-thread-context-bar"
          >
            <div className="no-scrollbar flex min-w-0 items-center gap-2 overflow-x-auto">
              {newThreadContextBar}
            </div>
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
              <Switch
                data-testid="prompt-worktree-switch"
                checked={createWorktree}
                onCheckedChange={onCreateWorktreeChange ?? (() => {})}
                tabIndex={-1}
                className="scale-90"
              />
              <span>{t('thread.mode.worktree')}</span>
            </label>
          </div>
        )}

        {/* Editor + bottom toolbar */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div
          ref={promptBoxRef}
          className={cn(
            'relative cursor-text rounded-md border bg-input/80',
            isDragging
              ? 'border-primary border-2 ring-2 ring-primary/20'
              : 'border-border/80 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50',
          )}
          onClick={handlePromptBoxClick}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Image previews */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-2">
              {images.map((img, idx) => (
                <div key={`preview-${idx}`} className="group relative">
                  <img
                    src={`data:${img.source.media_type};base64,${img.source.data}`}
                    alt={`Attachment ${idx + 1}`}
                    className="border-input max-h-10 min-h-10 max-w-24 min-w-10 cursor-pointer rounded border object-cover transition-opacity hover:opacity-80"
                    onClick={() => {
                      setLightboxIndex(idx);
                      setLightboxOpen(true);
                    }}
                  />
                  <button
                    onClick={() => removeImage(idx)}
                    aria-label={t('prompt.removeImage', 'Remove image')}
                    className="bg-destructive text-destructive-foreground absolute -top-1 -right-1 rounded-full p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                    disabled={loading}
                  >
                    <X className="icon-xs" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Attached text file previews */}
          {attachedTextFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-2">
              {attachedTextFiles.map((f, idx) => {
                const isUploading = f.mode === 'uploading';
                const sizeKb = Math.round(f.size / 1024) || '<1';
                const sizeLabel =
                  f.size >= 1024 * 1024
                    ? `${(f.size / (1024 * 1024)).toFixed(1)} MB`
                    : `${sizeKb} KB`;
                return (
                  <AttachmentChip
                    key={`file-preview-${idx}`}
                    data-testid={`prompt-attached-file-${idx}`}
                    name={f.name}
                    size={sizeLabel}
                    loading={isUploading}
                    onRemove={() => removeTextFile(idx)}
                    removeDisabled={loading || isUploading}
                    removeLabel={t('prompt.removeFile', 'Remove file')}
                    title={`${f.name} (${sizeLabel})${
                      f.mode === 'upload' ? ` — uploaded to ${f.path}` : ''
                    }`}
                  />
                );
              })}
            </div>
          )}

          {/* TipTap Editor */}
          <div ref={editorContainerRef} className="px-3 pt-2">
            <PromptEditor
              ref={editorRef}
              placeholder={editorPlaceholder}
              disabled={loading}
              onSubmit={handleSubmit}
              onCycleMode={handleCycleMode}
              onChange={handleEditorChange}
              onPaste={handleEditorPaste}
              onFileMentionDrop={() => setIsDragging(false)}
              cwd={editorCwd}
              slashSkills={slashSkills}
              slashSkillsLoading={slashSkillsLoading}
              sdkSlashCommands={sdkSlashCommands}
              commandProvider={commandProvider}
              containerRef={promptBoxRef}
            />
          </div>
          {/* Template variable inputs */}
          {isNewThread && isDeepAgent && templateVars.length > 0 && (
            <div className="border-t px-3 py-2">
              <div className="flex flex-wrap gap-2">
                {templateVars.map((v) => (
                  <div key={v.name} className="flex items-center gap-1.5">
                    <label
                      className="text-muted-foreground text-[10px] font-medium"
                      title={v.description || v.name}
                    >
                      {v.name}
                    </label>
                    <Input
                      value={templateVarValues[v.name] ?? v.defaultValue ?? ''}
                      onChange={(e) =>
                        setTemplateVarValues((prev) => ({
                          ...prev,
                          [v.name]: e.target.value,
                        }))
                      }
                      placeholder={v.description || v.name}
                      className="h-6 w-40 text-xs"
                      data-testid={`prompt-template-var-${v.name}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Bottom toolbar */}
          <input
            ref={fileInputRef}
            data-testid="prompt-file-input"
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            disabled={loading || running}
          />
          {/* Bottom toolbar — single row */}
          <div className="px-2 py-2.5">
            <div className="no-scrollbar flex h-9 items-center gap-1 overflow-x-auto px-px">
              <ModelSelect
                value={unifiedModel}
                effort={effort}
                onChange={handleUnifiedModelChange}
                onEffortChange={handleEffortChange}
                groups={modelGroups}
              />
              {isNewThread && isDeepAgent && templates.length > 0 && (
                <TemplateSelect
                  value={selectedTemplateId}
                  onChange={handleTemplateChange}
                  templates={templates}
                />
              )}
              <ModeSelect value={mode} onChange={onModeChange} modes={modes} />
              {isNewThread && showBacklog && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      data-testid="prompt-backlog-toggle"
                      onClick={() => onSendToBacklogChange?.(!sendToBacklog)}
                      tabIndex={-1}
                      className={cn(
                        'flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
                        sendToBacklog
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                      )}
                      aria-label={t('prompt.sendToBacklog')}
                    >
                      <Inbox className="icon-xs" />
                      {t('prompt.backlog')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t('prompt.sendToBacklog')}</TooltipContent>
                </Tooltip>
              )}
              {/* Attachment + dictation + send — always visible, pushed right */}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <Button
                  data-testid="prompt-attach"
                  onClick={() => fileInputRef.current?.click()}
                  variant="ghost"
                  size="icon-sm"
                  tabIndex={-1}
                  aria-label={t('prompt.attach')}
                  disabled={loading}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Paperclip className="icon-base" />
                </Button>
                {hasDictation && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        data-testid="prompt-dictate"
                        onClick={onToggleRecording}
                        variant="ghost"
                        size="icon-sm"
                        tabIndex={-1}
                        aria-label={
                          isRecording
                            ? t('prompt.stopDictation', 'Stop dictation')
                            : t('prompt.startDictation', 'Start dictation')
                        }
                        disabled={loading || isTranscribing}
                        className={cn(
                          'text-muted-foreground hover:text-foreground',
                          isRecording && 'text-destructive hover:text-destructive',
                        )}
                      >
                        {isTranscribing ? (
                          <Loader2 className="icon-sm animate-spin" />
                        ) : isRecording ? (
                          <MicOff className="icon-sm" />
                        ) : (
                          <Mic className="icon-sm" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {isTranscribing
                        ? t('prompt.transcribing', 'Transcribing...')
                        : isRecording
                          ? t('prompt.stopDictation', 'Stop dictation')
                          : t('prompt.startDictationPtt', 'Voice dictation (hold Ctrl+Alt)')}
                    </TooltipContent>
                  </Tooltip>
                )}
                {running && editorEmpty ? (
                  <Button
                    data-testid="prompt-stop"
                    onClick={onStop}
                    variant="destructive"
                    size="icon-sm"
                    tabIndex={-1}
                    aria-label={t('prompt.stopAgent')}
                  >
                    <Square className="icon-sm" />
                  </Button>
                ) : (
                  <Button
                    data-testid="prompt-send"
                    onClick={handleSubmit}
                    disabled={loading}
                    size="icon-sm"
                    tabIndex={-1}
                    aria-label={
                      running && isQueueMode
                        ? t('prompt.queueMessage')
                        : t('prompt.send', 'Send message')
                    }
                  >
                    {loading ? (
                      <Loader2 className="icon-sm animate-spin" />
                    ) : (
                      <ArrowUp className="icon-sm" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
        {/* Bottom bar — powerline / new-thread controls + context usage. Sits
            visually OUTSIDE the bordered prompt box. Skipped entirely when it
            would be empty (e.g. a new thread with no launcher / context ring),
            so the box stays tight against whatever follows (MCP list). */}
        {(typeof contextPct === 'number' || (isNewThread ? hasLauncher : !!powerlineThread)) && (
          <div className="mt-1.5 flex items-center gap-2 px-2">
            <div className="min-w-0 flex-1">
              {isNewThread ? (
                <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
                  {hasLauncher && (
                    <ModeSelect
                      value={runtime}
                      onChange={handleRuntimeChange}
                      modes={RUNTIME_MODES}
                    />
                  )}
                </div>
              ) : (
                // min-h matches the compact powerline row height so the row stays
                // vertically centered whether or not the diff-stats chip is present.
                <div className="no-scrollbar flex min-h-[15px] items-center gap-2 overflow-x-auto">
                  {powerlineThread && (
                    <ThreadPowerline
                      thread={powerlineThread}
                      projectName={powerlineProjectName}
                      projectColor={powerlineProjectColor}
                      projectTooltip={powerlineProjectPath}
                      gitStatus={powerlineGitStatus}
                      diffStatsSize="xs"
                      copyable
                      onDiffStatsClick={onOpenReview}
                      data-testid="prompt-powerline"
                    />
                  )}
                </div>
              )}
            </div>
            {typeof contextPct === 'number' && (
              <div className="shrink-0">
                <ContextUsageRing
                  pct={contextPct}
                  usedTokens={contextUsedTokens}
                  maxTokens={contextMaxTokens}
                  onCompact={onCompact ? () => setCompactConfirmOpen(true) : undefined}
                  disabled={!onCompact}
                />
              </div>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={compactConfirmOpen}
        onOpenChange={setCompactConfirmOpen}
        title={t('prompt.compactConfirmTitle', 'Compact conversation?')}
        description={t(
          'prompt.compactConfirmBody',
          'This summarizes the current conversation to free up context. Earlier messages are condensed and the full detail is no longer available to the agent.',
        )}
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmLabel={t('prompt.compactConfirmAction', 'Compact')}
        variant="default"
        onCancel={() => setCompactConfirmOpen(false)}
        onConfirm={() => {
          setCompactConfirmOpen(false);
          onCompact?.();
        }}
      />
    </div>
  );
});
