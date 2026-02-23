import { useMemo, useRef, useEffect, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ListTodo, MessageCircleQuestion, FileCode2, Play, CheckCircle2, Loader2 } from 'lucide-react';
import type { Message, ToolCall, ThreadStatus } from '@funny/shared';

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
    return questions[0].question as string ?? 'Question';
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

export function PromptTimeline({ messages, activeMessageId, threadStatus, onScrollToMessage, messagesScrollRef }: PromptTimelineProps) {
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

    // First pass: collect all TodoWrite snapshots to track per-task timestamps
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
    const lastTodoSnapshot = todoSnapshots.length > 0 ? todoSnapshots[todoSnapshots.length - 1] : null;

    // Build per-task timestamp map: find when each task first became in_progress or completed
    const todoTimestamps = new Map<string, string>();
    if (lastTodoSnapshot) {
      for (const todo of lastTodoSnapshot.todos) {
        const key = todo.content || todo.activeForm || '';
        // Search snapshots for the earliest timestamp where this task entered its current status
        for (const snap of todoSnapshots) {
          const match = snap.todos.find((t: any) =>
            (t.content || t.activeForm || '') === key
          );
          if (match) {
            if (todo.status === 'completed' && match.status === 'completed') {
              todoTimestamps.set(key, snap.timestamp);
              break;
            }
            if (todo.status === 'in_progress' && (match.status === 'in_progress' || match.status === 'completed')) {
              todoTimestamps.set(key, snap.timestamp);
              break;
            }
            if (todo.status === 'pending' && match.status !== undefined) {
              // For pending tasks, use the first snapshot where they appeared
              todoTimestamps.set(key, snap.timestamp);
              break;
            }
          }
        }
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

    // Track whether we've already inserted the todo items
    let todosInserted = false;

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

      // Scan assistant tool calls for questions, plans, and the first TodoWrite
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          // Insert individual todo items at the position of the first TodoWrite
          if (tc.name === 'TodoWrite' && !todosInserted && lastTodoSnapshot) {
            todosInserted = true;
            const total = lastTodoSnapshot.todos.length;
            for (let i = 0; i < total; i++) {
              const todo = lastTodoSnapshot.todos[i];
              const isInProgress = todo.status === 'in_progress';
              const step = `${i + 1}/${total}`;
              const label = isInProgress && todo.activeForm
                ? todo.activeForm
                : todo.content || todo.activeForm || `Task ${i + 1}`;
              const todoKey = todo.content || todo.activeForm || '';
              result.push({
                id: `todo-${i}`,
                content: `${step} · ${label}`,
                timestamp: todoTimestamps.get(todoKey) || m.timestamp,
                index: idx++,
                type: 'todo',
                toolCallId: lastTodoSnapshot.toolCallId,
                completed: todo.status === 'completed',
                inProgress: isInProgress,
              });
            }
            continue;
          }
          // Skip subsequent TodoWrite calls (already represented by individual items)
          if (tc.name === 'TodoWrite') continue;

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
    const isFinished = threadStatus === 'completed' || threadStatus === 'failed' || threadStatus === 'stopped';
    if (messages.length > 0 && isFinished) {
      const last = messages[messages.length - 1];
      const endLabel = threadStatus === 'completed' ? 'Completed' : threadStatus === 'failed' ? 'Failed' : 'Stopped';
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
        className="flex flex-col h-full w-[200px] flex-shrink-0 overflow-y-auto"
      >
        {/* Timeline */}
        <div className="flex-1 px-3 py-3">
          {groups.map((group, gi) => (
            <div key={gi}>
              {/* Date separator */}
              {group.date && (
                <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-2 mt-1">
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
    <div className="flex gap-2 group/milestone">
      {/* Vertical line + dot/icon */}
      <div className="flex flex-col items-center flex-shrink-0 w-4">
        {milestone.inProgress ? (
          <Loader2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-blue-400 animate-spin" />
        ) : Icon ? (
          <Icon className={cn('w-3.5 h-3.5 flex-shrink-0 mt-0.5', colors.icon)} />
        ) : (
          <div
            className={cn(
              'w-2.5 h-2.5 rounded-full border-2 flex-shrink-0 mt-0.5 transition-colors',
              isActive
                ? 'border-primary bg-primary'
                : 'border-primary/60 bg-background',
              'group-hover/milestone:border-primary group-hover/milestone:bg-primary/20'
            )}
          />
        )}
        {!isLast && (
          <div className="w-px flex-1 bg-border min-h-[16px]" />
        )}
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
              'hover:opacity-100 transition-opacity'
            )}
          >
            <div className={cn(
              'text-[10px] font-mono tabular-nums mb-0.5 transition-colors',
              isActive ? 'text-foreground/70' : 'text-muted-foreground/50'
            )}>
              {formatRelativeTime(milestone.timestamp)}
            </div>
            <div className={cn(
              'text-[11px] leading-snug line-clamp-2 transition-colors',
              milestone.inProgress
                ? 'text-blue-400 font-medium'
                : milestone.type !== 'prompt'
                  ? colors.text
                  : isActive
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground group-hover/btn:text-foreground',
              milestone.completed && 'line-through opacity-60'
            )}>
              {truncate(milestone.content, 80)}
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="left"
          align="start"
          className="max-w-[300px] p-3"
        >
          <div className="space-y-1.5">
            <div className="text-[10px] text-muted-foreground font-mono">
              {new Date(milestone.timestamp).toLocaleString([], {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </div>
            <pre className="text-xs whitespace-pre-wrap font-mono leading-relaxed break-words max-h-[200px] overflow-y-auto">
              {milestone.content.trim()}
            </pre>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
