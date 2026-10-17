import type { ThreadStatus } from '@funny/shared';
import {
  ListTodo,
  MessageCircleQuestion,
  FileCode2,
  Play,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { useMemo, useRef, useEffect, type RefObject } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import {
  buildPromptMilestones,
  type MilestoneType,
  type PromptMilestone,
  type TimelineMessage,
} from '@/lib/prompt-timeline-milestones';
import { cn } from '@/lib/utils';

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatRelativeTime(dateStr: string, now: number): string {
  const date = new Date(dateStr);
  const diffMs = now - date.getTime();
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

interface PromptTimelineProps {
  messages: TimelineMessage[];
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

  const milestones = useMemo(
    () => buildPromptMilestones(messages, threadStatus),
    [messages, threadStatus],
  );

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
        className="thread-timeline no-scrollbar flex h-full w-[200px] shrink-0 flex-col overflow-y-auto"
      >
        {/* Timeline */}
        <div className="flex-1 px-3 py-3">
          {groups.map((group, gi) => (
            <div key={group.date}>
              {/* Date separator */}
              {group.date && (
                <div className="text-muted-foreground/60 mt-1 mb-2 text-[10px] font-medium tracking-wider uppercase">
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
  const now = useMinuteTick();
  const Icon = MILESTONE_ICON[milestone.type];
  const colors = MILESTONE_COLOR[milestone.type];

  return (
    <div className="group/milestone flex gap-2">
      {/* Vertical line + dot/icon */}
      <div className="flex w-4 shrink-0 flex-col items-center">
        {milestone.inProgress ? (
          <Loader2 className="icon-sm mt-0.5 shrink-0 animate-spin text-blue-400" />
        ) : Icon ? (
          <Icon className={cn('icon-sm shrink-0 mt-0.5', colors.icon)} />
        ) : (
          <div
            className={cn(
              'w-2.5 h-2.5 rounded-full border shrink-0 mt-0.5 transition-colors',
              isActive ? 'border-primary bg-primary' : 'border-primary bg-transparent',
            )}
          />
        )}
        {!isLast && <div className="bg-border min-h-[16px] w-px flex-1" />}
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
            <div className="text-muted-foreground font-mono text-[10px]">
              {formatRelativeTime(milestone.timestamp, now)}
            </div>
            <ScrollArea className="max-h-[200px]">
              <pre className="font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
                {milestone.content.trim()}
              </pre>
            </ScrollArea>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
