import type { Message, ToolCall, ThreadStatus } from '@funny/shared';
import {
  ListTodo,
  MessageCircleQuestion,
  FileCode2,
  Play,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { useMemo, useRef, useEffect, type RefObject } from 'react';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type MilestoneType = 'prompt' | 'todo' | 'question' | 'plan' | 'start' | 'end';

interface PromptMilestone {
  id: string;
  content: string;
  timestamp: string;
  index: number;
  type: MilestoneType;
  /** Tool call ID for scrolling to tool call elements */
  toolCallId?: string;
  /** Whether this individual todo task is completed */
  completed?: boolean;
  /** Whether this individual todo task is currently in progress */
  inProgress?: boolean;
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  // For older dates, show the formatted time
  return formatTime(dateStr);
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const isToday =
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
  if (isToday) return '';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

function parseToolInput(input: string): Record<string, unknown> | null {
  try {
    return typeof input === 'string' ? JSON.parse(input) : input;
  } catch {
    return null;
  }
}

/** Extract a short summary for non-todo tool call milestones */
function getToolCallSummary(name: string, parsed: Record<string, unknown>): string | null {
  if (name === 'AskUserQuestion') {
    const questions = parsed.questions;
    if (!Array.isArray(questions) || questions.length === 0) return null;
    return (questions[0].question as string) ?? 'Question';
  }

  if (name === 'ExitPlanMode') {
    return 'Plan ready for review';
  }

  return null;
}

const TOOL_CALL_TYPES: Record<string, MilestoneType> = {
  TodoWrite: 'todo',
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
};

interface PromptTimelineProps {
  messages: (Message & { toolCalls?: ToolCall[] })[];
  activeMessageId?: string | null;
  threadStatus?: ThreadStatus;
  onScrollToMessage?: (messageId: string, toolCallId?: string) => void;
  /** Ref to the messages scroll container for bidirectional scroll sync */
  messagesScrollRef?: RefObject<HTMLDivElement | null>;
}

export function PromptTimeline({
  messages,
  activeMessageId,
  threadStatus,
  onScrollToMessage,
  messagesScrollRef,
}: PromptTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isSyncing = useRef(false);

  // Bidirectional scroll sync between timeline and messages
  useEffect(() => {
    const timeline = containerRef.current;
    const messagesEl = messagesScrollRef?.current;
    if (!timeline || !messagesEl) return;

    let rafId = 0;

    const syncScroll = (source: HTMLElement, target: HTMLElement) => {
      const sourceMax = source.scrollHeight - source.clientHeight;
      const targetMax = target.scrollHeight - target.clientHeight;
      if (sourceMax <= 0 || targetMax <= 0) return;
      const ratio = source.scrollTop / sourceMax;
      target.scrollTop = ratio * targetMax;
    };

    const onTimelineScroll = () => {
      if (isSyncing.current) return;
      isSyncing.current = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        syncScroll(timeline, messagesEl);
        rafId = requestAnimationFrame(() => {
          isSyncing.current = false;
        });
      });
    };

    const onMessagesScroll = () => {
      if (isSyncing.current) return;
      isSyncing.current = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        syncScroll(messagesEl, timeline);
        rafId = requestAnimationFrame(() => {
          isSyncing.current = false;
        });
      });
    };

    timeline.addEventListener('scroll', onTimelineScroll, { passive: true });
    messagesEl.addEventListener('scroll', onMessagesScroll, { passive: true });
    return () => {
      timeline.removeEventListener('scroll', onTimelineScroll);
      messagesEl.removeEventListener('scroll', onMessagesScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [messagesScrollRef]);

  const milestones = useMemo<PromptMilestone[]>(() => {
    let idx = 0;
    const result: PromptMilestone[] = [];

    // First pass: collect all TodoWrite snapshots to track per-task history
    const todoSnapshots: { todos: any[]; toolCallId: string; timestamp: string }[] = [];
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (tc.name === 'TodoWrite') {
            const parsed = parseToolInput(tc.input);
            if (parsed) {
              const todos = parsed.todos;
              if (Array.isArray(todos) && todos.length > 0) {
                todoSnapshots.push({ todos, toolCallId: tc.id, timestamp: m.timestamp });
              }
            }
          }
        }
      }
    }
    const lastTodoSnapshot =
      todoSnapshots.length > 0 ? todoSnapshots[todoSnapshots.length - 1] : null;

    // Build a map of each todo's first-appearance timestamp and latest status.
    // Key = todo content string. We track when a todo first appeared in any snapshot
    // and its most recent status from the last snapshot that contains it.
    const todoFirstSeen = new Map<
      string,
      { timestamp: string; toolCallId: string; snapshotIdx: number }
    >();
    const todoLatestStatus = new Map<
      string,
      { status: string; activeForm?: string; content?: string }
    >();

    for (let si = 0; si < todoSnapshots.length; si++) {
      const snap = todoSnapshots[si];
      for (const todo of snap.todos) {
        const key = todo.content || todo.activeForm || '';
        if (!todoFirstSeen.has(key)) {
          todoFirstSeen.set(key, {
            timestamp: snap.timestamp,
            toolCallId: snap.toolCallId,
            snapshotIdx: si,
          });
        }
        // Always update to latest status
        todoLatestStatus.set(key, {
          status: todo.status,
          activeForm: todo.activeForm,
          content: todo.content,
        });
      }
    }

    // Group todos by the snapshot where they first appeared, preserving order
    const todosByFirstSnapshot = new Map<number, string[]>();
    if (lastTodoSnapshot) {
      for (const todo of lastTodoSnapshot.todos) {
        const key = todo.content || todo.activeForm || '';
        const firstSeen = todoFirstSeen.get(key);
        if (!firstSeen) continue;
        const si = firstSeen.snapshotIdx;
        if (!todosByFirstSnapshot.has(si)) todosByFirstSnapshot.set(si, []);
        todosByFirstSnapshot.get(si)!.push(key);
      }
    }

    // Start marker — first message timestamp
    if (messages.length > 0) {
      const first = messages[0];
      result.push({
        id: 'timeline-start',
        content: 'Start',
        timestamp: first.timestamp,
        index: idx++,
        type: 'start',
      });
    }

    // Track which TodoWrite snapshots we've already emitted todos for
    let nextSnapshotToEmit = 0;
    // Total number of todos from the latest snapshot (for step numbering)
    const totalTodos = lastTodoSnapshot ? lastTodoSnapshot.todos.length : 0;
    // Track global todo index for step numbering
    let todoIndex = 0;

    for (const m of messages) {
      // User messages become prompt milestones
      if (m.role === 'user' && m.content?.trim()) {
        result.push({
          id: m.id,
          content: m.content,
          timestamp: m.timestamp,
          index: idx++,
          type: 'prompt',
        });
      }

      // Scan assistant tool calls for questions, plans, and TodoWrites
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (tc.name === 'TodoWrite') {
            // Emit todos that first appeared in snapshots up to and including this one
            while (
              nextSnapshotToEmit < todoSnapshots.length &&
              todoSnapshots[nextSnapshotToEmit].toolCallId === tc.id
            ) {
              break;
            }
            // Find which snapshot index this tool call corresponds to
            const snapIdx = todoSnapshots.findIndex((s) => s.toolCallId === tc.id);
            if (snapIdx < 0) continue;

            // Emit all pending snapshot groups up to this one
            for (let si = nextSnapshotToEmit; si <= snapIdx; si++) {
              const todoKeys = todosByFirstSnapshot.get(si);
              if (!todoKeys) continue;
              for (const key of todoKeys) {
                const latest = todoLatestStatus.get(key);
                const firstSeen = todoFirstSeen.get(key);
                if (!latest || !firstSeen) continue;
                const isFinishedThread =
                  threadStatus === 'completed' ||
                  threadStatus === 'failed' ||
                  threadStatus === 'stopped';
                const isInProgress = latest.status === 'in_progress' && !isFinishedThread;
                const isCompleted =
                  latest.status === 'completed' ||
                  (latest.status === 'in_progress' && isFinishedThread);
                const step = `${todoIndex + 1}/${totalTodos}`;
                const label =
                  isInProgress && latest.activeForm
                    ? latest.activeForm
                    : latest.content || latest.activeForm || `Task ${todoIndex + 1}`;
                result.push({
                  id: `todo-${tc.id}-${todoIndex}`,
                  content: `${step} · ${label}`,
                  timestamp: firstSeen.timestamp,
                  index: idx++,
                  type: 'todo',
                  toolCallId: firstSeen.toolCallId,
                  completed: isCompleted,
                  inProgress: isInProgress,
                });
                todoIndex++;
              }
            }
            nextSnapshotToEmit = snapIdx + 1;
            continue;
          }

          const milestoneType = TOOL_CALL_TYPES[tc.name];
          if (!milestoneType) continue;

          const parsed = parseToolInput(tc.input);
          if (!parsed) continue;

          const summary = getToolCallSummary(tc.name, parsed);
          if (!summary) continue;

          result.push({
            id: `tc-${tc.id}`,
            content: summary,
            timestamp: m.timestamp,
            index: idx++,
            type: milestoneType,
            toolCallId: tc.id,
          });
        }
      }
    }

    // End marker — only for finished threads
    const isFinished =
      threadStatus === 'completed' || threadStatus === 'failed' || threadStatus === 'stopped';
    if (messages.length > 0 && isFinished) {
      const last = messages[messages.length - 1];
      const endLabel =
        threadStatus === 'completed'
          ? 'Completed'
          : threadStatus === 'failed'
            ? 'Failed'
            : 'Stopped';
      result.push({
        id: 'timeline-end',
        content: endLabel,
        timestamp: last.timestamp,
        index: idx++,
        type: 'end',
      });
    }

    return result;
  }, [messages, threadStatus]);

  if (milestones.length === 0) return null;

  // Group milestones by date
  const groups: { date: string; milestones: PromptMilestone[] }[] = [];
  for (const ms of milestones) {
    const dateLabel = formatDate(ms.timestamp);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.date === dateLabel) {
      lastGroup.milestones.push(ms);
    } else {
      groups.push({ date: dateLabel, milestones: [ms] });
    }
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div
        ref={containerRef}
        className="thread-timeline no-scrollbar flex h-full w-[200px] flex-shrink-0 flex-col overflow-y-auto"
      >
        {/* Timeline */}
        <div className="flex-1 px-3 py-3">
          {groups.map((group, gi) => (
            <div key={group.date}>
              {/* Date separator */}
              {group.date && (
                <div className="mb-2 mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  {group.date}
                </div>
              )}

              {group.milestones.map((ms, mi) => {
                const isLast = gi === groups.length - 1 && mi === group.milestones.length - 1;
                const isActive = ms.type === 'prompt' && ms.id === activeMessageId;
                return (
                  <TimelineMilestone
                    key={ms.id}
                    milestone={ms}
                    isLast={isLast}
                    isActive={isActive}
                    onScrollTo={onScrollToMessage}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}

const MILESTONE_ICON: Record<MilestoneType, typeof ListTodo | null> = {
  prompt: null,
  todo: ListTodo,
  question: MessageCircleQuestion,
  plan: FileCode2,
  start: Play,
  end: CheckCircle2,
};

const MILESTONE_COLOR: Record<MilestoneType, { icon: string; text: string }> = {
  prompt: { icon: '', text: '' },
  todo: { icon: 'text-muted-foreground', text: 'text-muted-foreground' },
  question: { icon: 'text-muted-foreground', text: 'text-muted-foreground' },
  plan: { icon: 'text-muted-foreground', text: 'text-muted-foreground' },
  start: { icon: 'text-muted-foreground', text: 'text-muted-foreground' },
  end: { icon: 'text-muted-foreground', text: 'text-muted-foreground' },
};

function TimelineMilestone({
  milestone,
  isLast,
  isActive,
  onScrollTo,
}: {
  milestone: PromptMilestone;
  isLast: boolean;
  isActive: boolean;
  onScrollTo?: (messageId: string, toolCallId?: string) => void;
}) {
  const Icon = MILESTONE_ICON[milestone.type];
  const colors = MILESTONE_COLOR[milestone.type];

  return (
    <div className="group/milestone flex gap-2">
      {/* Vertical line + dot/icon */}
      <div className="flex w-4 flex-shrink-0 flex-col items-center">
        {milestone.inProgress ? (
          <Loader2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 animate-spin text-blue-400" />
        ) : Icon ? (
          <Icon className={cn('w-3.5 h-3.5 flex-shrink-0 mt-0.5', colors.icon)} />
        ) : (
          <div
            className={cn(
              'w-2.5 h-2.5 rounded-full border flex-shrink-0 mt-0.5 transition-colors',
              isActive ? 'border-primary bg-primary' : 'border-primary bg-transparent',
            )}
          />
        )}
        {!isLast && <div className="min-h-[16px] w-px flex-1 bg-border" />}
      </div>

      {/* Content */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => {
              if (milestone.type === 'prompt') {
                onScrollTo?.(milestone.id);
              } else {
                // For tool call milestones, pass the original message ID + tool call ID
                onScrollTo?.(milestone.id, milestone.toolCallId);
              }
            }}
            className={cn(
              'flex-1 text-left pb-4 min-w-0 group/btn cursor-pointer',
              'hover:opacity-100 transition-opacity',
            )}
          >
            <div
              className={cn(
                'text-[11px] leading-snug line-clamp-2 transition-colors',
                milestone.inProgress
                  ? 'text-blue-400 font-medium'
                  : milestone.type !== 'prompt'
                    ? colors.text
                    : isActive
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground group-hover/btn:text-foreground',
                milestone.completed && 'line-through opacity-60',
              )}
            >
              {truncate(milestone.content, 80)}
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" align="start" className="max-w-[300px] p-3">
          <div className="space-y-1.5">
            <div className="font-mono text-[10px] text-muted-foreground">
              {formatRelativeTime(milestone.timestamp)}
            </div>
            <pre className="max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
              {milestone.content.trim()}
            </pre>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
