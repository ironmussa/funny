import type {
  AgentTemplate,
  ImageAttachment,
  QueuedMessage,
  Skill,
  ThreadPurpose,
} from '@funny/shared';
import {
  ArrowUp,
  ArrowLeft,
  Square,
  Loader2,
  Paperclip,
  Mic,
  MicOff,
  X,
  GitBranch,
  Inbox,
  FolderOpen,
  Copy,
  ListOrdered,
  Pencil,
  Trash2,
  Check,
  Compass,
  Map,
  Hammer,
  Bot,
} from 'lucide-react';
import { useState, useRef, useCallback, useMemo, memo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import { cn } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';

import { ImageLightbox } from './ImageLightbox';
import type { PromptEditorHandle } from './prompt-editor/PromptEditor';
import { PromptEditor } from './prompt-editor/PromptEditor';
import { serializeEditorContent } from './prompt-editor/serialize';
import { BranchPicker } from './SearchablePicker';

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
  models: { value: string; label: string }[];
};

export const ModelSelect = memo(function ModelSelect({
  value,
  onChange,
  groups,
}: {
  value: string;
  onChange: (v: string) => void;
  groups: ModelSelectGroup[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        data-testid="prompt-model-select"
        tabIndex={-1}
        size="xs"
        className="w-auto border-none bg-transparent shadow-none"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent side="top" align="end">
        {groups.map((group, idx) => (
          <SelectGroup key={group.provider}>
            {idx > 0 && <SelectSeparator />}
            <SelectLabel>{group.providerLabel}</SelectLabel>
            {group.models.map((m) => (
              <SelectItem key={m.value} value={m.value} size="xs">
                {m.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
});

const PURPOSE_OPTIONS = [
  { value: 'explore' as const, label: 'Explore', icon: Compass },
  { value: 'plan' as const, label: 'Plan', icon: Map },
  { value: 'implement' as const, label: 'Implement', icon: Hammer },
];

export const PurposeSelect = memo(function PurposeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        data-testid="prompt-purpose-select"
        tabIndex={-1}
        size="xs"
        className="w-auto border-none bg-transparent shadow-none"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent side="top" align="start">
        {PURPOSE_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          return (
            <SelectItem key={opt.value} value={opt.value} size="xs">
              <span className="flex items-center gap-1.5">
                <Icon className="icon-xs" />
                {opt.label}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
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
            className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
            style={{ backgroundColor: tpl.color }}
          />
        )}
        <span className="truncate">{tpl.name}</span>
        {tpl.model && (
          <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
            {tpl.model}
          </span>
        )}
      </span>
      {tpl.description && (
        <span className="block truncate pl-3.5 text-[10px] text-muted-foreground">
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

export const EffortSelect = memo(function EffortSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; description: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        data-testid="prompt-effort-select"
        tabIndex={-1}
        size="xs"
        className="w-auto border-none bg-transparent shadow-none"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent side="top" align="start">
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} size="xs">
            <span title={opt.description}>{opt.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});

/** Parse a git remote URL into a friendly `owner/repo` display string. */
export function formatRemoteUrl(url: string): string {
  const sshMatch = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return path;
  } catch {
    return url;
  }
}

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
      purpose?: ThreadPurpose;
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
  effectiveCwd?: string;

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
  loadSkills?: () => Promise<Skill[]>;
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

  // ── Arc / Purpose ──
  purpose?: ThreadPurpose;
  onPurposeChange?: (v: ThreadPurpose) => void;
  arcId?: string;
  /** Callback to trigger phase transition: creates new thread with same arcId but different purpose */
  onPhaseTransition?: (newPurpose: ThreadPurpose) => void;

  // ── Effort (Claude-specific) ──
  effort?: string;
  onEffortChange?: (v: string) => void;
  effortOptions?: { value: string; label: string; description: string }[];

  // ── Default template (from project settings) ──
  defaultTemplateId?: string;
}

// ── Component ────────────────────────────────────────────────────

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
  createWorktree = false,
  onCreateWorktreeChange,
  runtime = 'local',
  onRuntimeChange,
  hasLauncher = false,
  selectedBranch = '',
  followUpBranches = [],
  followUpRemoteBranches = [],
  followUpDefaultBranch = null,
  followUpSelectedBranch = '',
  onFollowUpSelectedBranchChange,
  activeThreadBranch,
  effectiveCwd,
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
  setPromptRef,
  editorRef: externalEditorRef,
  editorContainerRef: externalEditorContainerRef,
  initialPrompt: _initialPrompt,
  initialImages,
  onEditorChange,
  onEditorPaste,
  onCheckoutPreflight,
  purpose = 'implement',
  onPurposeChange,
  arcId,
  onPhaseTransition,
  effort,
  onEffortChange,
  effortOptions,
  defaultTemplateId,
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

    // Checkout preflight for local mode
    if (isNewThread && !createWorktree && onCheckoutPreflight && selectedBranch) {
      const canProceed = await onCheckoutPreflight(selectedBranch);
      if (!canProceed) return;
    }

    const submittedPrompt = serialized.text;
    const submittedImages = images.length > 0 ? images : undefined;
    const submittedFiles =
      serialized.fileReferences.length > 0 ? serialized.fileReferences : undefined;
    const submittedSymbols =
      serialized.symbolReferences.length > 0 ? serialized.symbolReferences : undefined;
    editorRef.current?.clear();
    setImages([]);
    setEditorEmpty(true);
    editorRef.current?.focus();

    const isLocalOnlyPurpose = purpose !== 'implement';
    const result = await onSubmit(
      submittedPrompt,
      {
        provider,
        model,
        mode,
        effort,
        ...(isNewThread
          ? {
              threadMode: isLocalOnlyPurpose ? 'local' : createWorktree ? 'worktree' : 'local',
              runtime,
              baseBranch: selectedBranch || undefined,
              sendToBacklog,
              purpose,
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
    }
  }, [
    loading,
    isRecording,
    onStopRecording,
    images,
    t,
    isNewThread,
    createWorktree,
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
    purpose,
    isDeepAgent,
    selectedTemplateId,
  ]);

  // ── Editor callbacks ──
  const handleEditorChange = useCallback(() => {
    setEditorEmpty(editorRef.current?.isEmpty() ?? true);
    onEditorChange?.();
  }, [onEditorChange, editorRef]);

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
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
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
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true);
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
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        await addImageFile(file);
      } else {
        // Non-image files → insert as file mention in the editor
        const filePath = (file as any).path || file.name;
        editorRef.current?.insertFileMention(filePath, 'file');
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
        const filePath = (file as any).path || file.name;
        editorRef.current?.insertFileMention(filePath, 'file');
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
    <div className="border-border">
      <div className="mx-auto w-full min-w-0 max-w-3xl pb-4">
        {/* Image previews */}
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img, idx) => (
              <div key={`preview-${idx}`} className="group relative">
                <img
                  src={`data:${img.source.media_type};base64,${img.source.data}`}
                  alt={`Attachment ${idx + 1}`}
                  className="max-h-10 min-h-10 min-w-10 max-w-24 cursor-pointer rounded border border-input object-cover transition-opacity hover:opacity-80"
                  onClick={() => {
                    setLightboxIndex(idx);
                    setLightboxOpen(true);
                  }}
                />
                <button
                  onClick={() => removeImage(idx)}
                  aria-label={t('prompt.removeImage', 'Remove image')}
                  className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  disabled={loading}
                >
                  <X className="icon-xs" />
                </button>
              </div>
            ))}
          </div>
        )}

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
            className="mb-2 space-y-2 rounded-md border border-border/40 px-2.5 py-2"
          >
            <div className="flex items-center gap-1.5">
              <ListOrdered className="icon-xs shrink-0 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {(queuedMessagesProp.length > 0 ? queuedMessagesProp.length : queuedCount) === 1
                  ? t('prompt.queuedOne', '1 message in queue')
                  : t('prompt.queuedMany', '{{count}} messages in queue', {
                      count:
                        queuedMessagesProp.length > 0 ? queuedMessagesProp.length : queuedCount,
                    })}
              </span>
            </div>

            {queueLoading ? (
              <div className="flex items-center gap-2 rounded-md border border-dashed border-border/60 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="icon-xs animate-spin" />
                {t('prompt.loadingQueuedMessages', 'Loading queued messages...')}
              </div>
            ) : (
              <div className="divide-y divide-border [&>*]:bg-transparent">
                {queuedMessagesProp.map((message, index) => {
                  const isEditing = editingQueuedMessageId === message.id;
                  const isBusy = queueActionMessageId === message.id;

                  return (
                    <div
                      key={message.id}
                      data-testid={`queue-item-${message.id}`}
                      className="bg-transparent px-1 py-1 first:pt-0 last:pb-0"
                    >
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            #{index + 1}
                          </span>
                          <Input
                            data-testid={`queue-edit-textarea-${message.id}`}
                            value={editingQueuedMessageContent}
                            onChange={(event) => setEditingQueuedMessageContent(event.target.value)}
                            disabled={isBusy}
                            className="h-7 flex-1 bg-background text-xs"
                          />
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Button
                              data-testid={`queue-save-${message.id}`}
                              type="button"
                              size="icon-xs"
                              onClick={() => handleQueueEditSave(message.id)}
                              disabled={isBusy}
                              aria-label={t('prompt.saveQueuedMessage', 'Save')}
                              title={t('prompt.saveQueuedMessage', 'Save')}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              {isBusy ? (
                                <Loader2 className="icon-xs animate-spin" />
                              ) : (
                                <Check className="icon-xs" />
                              )}
                            </Button>
                            <Button
                              data-testid={`queue-cancel-edit-${message.id}`}
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              onClick={handleQueueEditCancel}
                              disabled={isBusy}
                              aria-label={t('prompt.cancelQueuedEdit', 'Cancel')}
                              title={t('prompt.cancelQueuedEdit', 'Cancel')}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <X className="icon-xs" />
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            #{index + 1}
                          </span>
                          <p
                            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                            title={message.content}
                          >
                            {message.content}
                          </p>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Button
                              data-testid={`queue-edit-${message.id}`}
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => handleQueueEditStart(message)}
                              disabled={isBusy}
                              aria-label={t('prompt.editQueuedMessage', 'Edit')}
                              title={t('prompt.editQueuedMessage', 'Edit')}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <Pencil className="icon-xs" />
                            </Button>
                            <Button
                              data-testid={`queue-delete-${message.id}`}
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => handleQueueDelete(message.id)}
                              disabled={isBusy}
                              aria-label={t('prompt.deleteQueuedMessage', 'Delete')}
                              title={t('prompt.deleteQueuedMessage', 'Delete')}
                              className="text-destructive hover:text-destructive"
                            >
                              {isBusy ? (
                                <Loader2 className="icon-xs animate-spin" />
                              ) : (
                                <Trash2 className="icon-xs" />
                              )}
                            </Button>
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
              cwd={editorCwd}
              loadSkills={loadSkills}
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
                      className="text-[10px] font-medium text-muted-foreground"
                      title={v.description || v.name}
                    >
                      {v.name}
                    </label>
                    <Input
                      value={templateVarValues[v.name] ?? v.defaultValue ?? ''}
                      onChange={(e) =>
                        setTemplateVarValues((prev) => ({ ...prev, [v.name]: e.target.value }))
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
            <div className="no-scrollbar flex h-9 items-center gap-1 overflow-x-auto">
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
              {isNewThread && (
                <PurposeSelect
                  value={purpose}
                  onChange={(v) => onPurposeChange?.(v as ThreadPurpose)}
                />
              )}
              {!isNewThread && arcId && (
                <PurposeSelect
                  value={purpose}
                  onChange={(v) => onPhaseTransition?.(v as ThreadPurpose)}
                />
              )}
              {isNewThread && isDeepAgent && templates.length > 0 && (
                <TemplateSelect
                  value={selectedTemplateId}
                  onChange={(v) => {
                    setSelectedTemplateId(v);
                    setTemplateVarValues({});
                  }}
                  templates={templates}
                />
              )}
              <ModeSelect value={mode} onChange={onModeChange} modes={modes} />
              {/* Model + effort + send — always visible, pushed right */}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <ModelSelect
                  value={unifiedModel}
                  onChange={onUnifiedModelChange}
                  groups={modelGroups}
                />
                {effortOptions && effortOptions.length > 0 && effort && onEffortChange && (
                  <EffortSelect value={effort} onChange={onEffortChange} options={effortOptions} />
                )}
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
          {/* Separator + Bottom bar */}
          <div className="border-t border-border px-2 py-1.5">
            {isNewThread ? (
              <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
                {purpose === 'implement' && (
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch
                      data-testid="prompt-worktree-switch"
                      checked={createWorktree}
                      onCheckedChange={onCreateWorktreeChange ?? (() => {})}
                      tabIndex={-1}
                    />
                    <span>{t('thread.mode.worktree')}</span>
                  </label>
                )}
                {hasLauncher && (
                  <ModeSelect
                    value={runtime}
                    onChange={(v) => onRuntimeChange?.(v as 'local' | 'remote')}
                    modes={[
                      { value: 'local', label: 'Local' },
                      { value: 'remote', label: 'Remote' },
                    ]}
                  />
                )}
                {showBacklog && (
                  <button
                    data-testid="prompt-backlog-toggle"
                    onClick={() => onSendToBacklogChange?.(!sendToBacklog)}
                    tabIndex={-1}
                    className={cn(
                      'flex items-center gap-1 pl-2 py-1 text-xs rounded transition-colors shrink-0 ml-auto',
                      sendToBacklog
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                    )}
                    title={t('prompt.sendToBacklog')}
                  >
                    <Inbox className="icon-xs" />
                    {t('prompt.backlog')}
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col">
                {effectiveCwd && (
                  <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
                    <span className="group/cwd flex max-w-[400px] shrink-0 items-center gap-1 truncate px-2 py-1 text-xs text-muted-foreground">
                      <FolderOpen className="icon-xs shrink-0" />
                      <span className="truncate font-mono">{effectiveCwd}</span>
                      <button
                        type="button"
                        className="shrink-0 opacity-0 transition-colors hover:text-foreground group-hover/cwd:opacity-100"
                        onClick={() => {
                          navigator.clipboard.writeText(effectiveCwd);
                          toast.success('Path copied');
                        }}
                      >
                        <Copy className="icon-xs" />
                      </button>
                    </span>
                  </div>
                )}
                {(followUpBranches.length > 0 || activeThreadBranch) && (
                  <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
                    {followUpBranches.length > 0 && (
                      <BranchPicker
                        branches={followUpBranches}
                        remoteBranches={followUpRemoteBranches}
                        defaultBranch={followUpDefaultBranch}
                        selected={followUpSelectedBranch}
                        onChange={onFollowUpSelectedBranchChange ?? (() => {})}
                      />
                    )}
                    {activeThreadBranch && followUpBranches.length > 0 && (
                      <ArrowLeft className="icon-xs shrink-0 text-muted-foreground" />
                    )}
                    {activeThreadBranch && (
                      <button
                        type="button"
                        data-testid="prompt-branch-readonly"
                        className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
                        onClick={() => {
                          navigator.clipboard.writeText(activeThreadBranch);
                          toast.success(t('prompt.branchCopied', 'Branch copied'));
                        }}
                      >
                        <GitBranch className="icon-xs shrink-0" />
                        <span className="font-mono font-medium text-foreground">
                          {activeThreadBranch}
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
