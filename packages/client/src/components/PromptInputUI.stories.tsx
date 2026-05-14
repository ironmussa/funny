import type { Meta, StoryObj } from '@storybook/react-vite';
import { Send, Mic } from 'lucide-react';
import { type ComponentProps, useRef, useState, useCallback, useEffect } from 'react';
import { fn } from 'storybook/test';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { PromptEditor } from '@/components/prompt-editor/PromptEditor';
import { PromptInputUI } from '@/components/PromptInputUI';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const defaultModes = [
  { value: 'ask', label: 'Ask' },
  { value: 'plan', label: 'Plan' },
  { value: 'autoEdit', label: 'Auto-edit' },
  { value: 'confirmEdit', label: 'Ask before edits' },
];

const defaultModelGroups = [
  {
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    models: [
      { value: 'anthropic:claude-sonnet-4-20250514', label: 'Sonnet 4' },
      { value: 'anthropic:claude-opus-4-20250514', label: 'Opus 4' },
      { value: 'anthropic:claude-haiku-3-5-20241022', label: 'Haiku 3.5' },
    ],
  },
  {
    provider: 'openai',
    providerLabel: 'OpenAI',
    models: [
      { value: 'openai:gpt-4o', label: 'GPT-4o' },
      { value: 'openai:o3', label: 'o3' },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Meta                                                               */
/* ------------------------------------------------------------------ */

const meta: Meta<typeof PromptInputUI> = {
  title: 'Components/PromptInput',
  component: PromptInputUI,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  args: {
    onSubmit: fn(),
    onStop: fn(),
    loading: false,
    running: false,
    unifiedModel: 'anthropic:claude-sonnet-4-20250514',
    onUnifiedModelChange: fn(),
    modelGroups: defaultModelGroups,
    mode: 'autoEdit',
    onModeChange: fn(),
    modes: defaultModes,
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Default idle state for a new thread. */
export const Default: Story = {
  args: {
    isNewThread: true,
    placeholder: 'Describe a task...',
  },
};

/** Follow-up prompt on an existing thread. */
export const FollowUp: Story = {
  args: {
    isNewThread: false,
    effectiveCwd: '/home/user/projects/my-app',
    activeThreadBranch: 'feature/dark-mode',
    followUpBranches: ['main', 'develop', 'feature/dark-mode'],
    followUpSelectedBranch: 'main',
    onFollowUpSelectedBranchChange: fn(),
  },
};

/** Agent is running — shows the stop button when editor is empty. */
export const Running: Story = {
  args: {
    running: true,
    isQueueMode: true,
    placeholder: 'Type to queue a follow-up...',
  },
};

/** Submit button in loading state. */
export const Loading: Story = {
  args: {
    loading: true,
  },
};

/** New thread with worktree toggle visible. */
export const NewThreadWithBranches: Story = {
  args: {
    isNewThread: true,
    selectedBranch: 'main',
    createWorktree: false,
    onCreateWorktreeChange: fn(),
  },
};

/** New thread with worktree enabled. */
export const WorktreeMode: Story = {
  args: {
    isNewThread: true,
    selectedBranch: 'main',
    createWorktree: true,
    onCreateWorktreeChange: fn(),
  },
};

/** With queued messages. */
export const WithQueue: Story = {
  args: {
    running: true,
    isQueueMode: true,
    queuedMessages: [
      {
        id: 'q1',
        threadId: 't1',
        content: 'Add error handling to the API endpoints',
        sortOrder: 0,
        createdAt: '2026-03-13T10:00:00Z',
      },
      {
        id: 'q2',
        threadId: 't1',
        content: 'Write tests for the new auth middleware',
        sortOrder: 1,
        createdAt: '2026-03-13T10:01:00Z',
      },
      {
        id: 'q3',
        threadId: 't1',
        content: 'Update the README with setup instructions',
        sortOrder: 2,
        createdAt: '2026-03-13T10:02:00Z',
      },
    ],
    onQueueEditSave: fn(),
    onQueueDelete: fn(),
  },
};

/** With dictation button visible (static, idle). */
export const WithDictation: Story = {
  args: {
    hasDictation: true,
    isRecording: false,
    isTranscribing: false,
    onToggleRecording: fn(),
    onStopRecording: fn(),
  },
};

/** Dictation actively recording (static). */
export const DictationRecording: Story = {
  args: {
    hasDictation: true,
    isRecording: true,
    isTranscribing: false,
    onToggleRecording: fn(),
    onStopRecording: fn(),
  },
};

function DictationPushToTalkStory(args: ComponentProps<typeof PromptInputUI>) {
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && !isRecording) {
        setIsRecording(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (isRecording && (e.key === 'Control' || e.key === 'Alt')) {
        setTimeout(() => setIsRecording(false), 500);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isRecording]);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Hold <kbd className="rounded border bg-background px-1 py-0.5 font-mono">Ctrl</kbd> +{' '}
        <kbd className="rounded border bg-background px-1 py-0.5 font-mono">Alt</kbd> to simulate
        recording. Release to stop.
        <span className="ml-2 font-semibold">
          Status: {isRecording ? '🔴 Recording' : '⚪ Idle'}
        </span>
      </div>
      <PromptInputUI
        {...args}
        hasDictation
        isRecording={isRecording}
        isTranscribing={false}
        onToggleRecording={() => setIsRecording((r) => !r)}
        onStopRecording={() => setIsRecording(false)}
      />
    </div>
  );
}

/** Interactive push-to-talk: hold Ctrl+Alt to record, release to stop. */
export const DictationPushToTalk: StoryObj<typeof PromptInputUI> = {
  name: 'Dictation (Push-to-Talk)',
  render: (args) => <DictationPushToTalkStory {...args} />,
  args: {
    onSubmit: fn(),
    onStop: fn(),
    loading: false,
    running: false,
    unifiedModel: 'anthropic:claude-sonnet-4-20250514',
    onUnifiedModelChange: fn(),
    modelGroups: defaultModelGroups,
    mode: 'autoEdit',
    onModeChange: fn(),
    modes: defaultModes,
    isNewThread: true,
    placeholder: 'Describe a task...',
  },
};

/** With backlog toggle visible. */
export const WithBacklog: Story = {
  args: {
    isNewThread: true,
    showBacklog: true,
    sendToBacklog: false,
    onSendToBacklogChange: fn(),
    selectedBranch: 'main',
  },
};

/** With remote launcher (shows local/remote runtime selector). */
export const WithLauncher: Story = {
  args: {
    isNewThread: true,
    hasLauncher: true,
    runtime: 'local',
    onRuntimeChange: fn(),
    selectedBranch: 'main',
  },
};

/* ------------------------------------------------------------------ */
/*  Minimal — PromptEditor with mic + send only                        */
/* ------------------------------------------------------------------ */

function MinimalStory() {
  const editorRef = useRef<PromptEditorHandle>(null);
  const [hasContent, setHasContent] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);

  const trackEditorContent = useCallback(() => {
    const text = (editorRef.current?.getText() ?? '').trim();
    setHasContent(text.length > 0);
  }, []);

  const handleSubmit = useCallback(() => {
    const text = (editorRef.current?.getText() ?? '').trim();
    if (!text) return;
    setSubmitted(text);
    editorRef.current?.clear();
    setHasContent(false);
  }, []);

  return (
    <div className="mx-auto max-w-lg space-y-3">
      <p className="text-xs text-muted-foreground">
        Minimal variant used inside tool cards (Plan, AskQuestion). Only mic + send buttons.
      </p>

      <div className="rounded-md border border-border/40 bg-background/50 focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20">
        <div className="px-2.5 py-1.5">
          <PromptEditor
            ref={editorRef}
            placeholder="Type instructions or feedback..."
            onSubmit={handleSubmit}
            onChange={trackEditorContent}
            className="max-h-[120px] min-h-[40px] overflow-y-auto text-sm"
          />
        </div>
        <div className="flex items-center justify-end gap-1 border-t border-border/20 px-1.5 py-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-testid="minimal-dictate"
                variant="ghost"
                size="icon-sm"
                tabIndex={-1}
                className="text-muted-foreground hover:text-foreground"
              >
                <Mic className="icon-xs" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Start dictation</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-testid="minimal-send"
                onClick={handleSubmit}
                variant="ghost"
                size="icon-sm"
                tabIndex={-1}
                disabled={!hasContent}
                className={cn(
                  'text-muted-foreground hover:text-foreground',
                  hasContent && 'text-primary hover:text-primary',
                )}
              >
                <Send className="icon-xs" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Send</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {submitted && (
        <div className="rounded-md border border-border/40 bg-muted/30 p-3">
          <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
            Submitted
          </div>
          <pre className="whitespace-pre-wrap text-xs text-foreground">{submitted}</pre>
        </div>
      )}
    </div>
  );
}

/** Minimal editor with just mic and send buttons (used in tool cards like Plan, AskQuestion). */
export const Minimal: StoryObj = {
  name: 'Minimal (Mic + Send)',
  render: () => <MinimalStory />,
};
