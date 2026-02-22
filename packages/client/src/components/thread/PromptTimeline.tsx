import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageCircle } from 'lucide-react';
import type { Message } from '@funny/shared';

interface PromptMilestone {
  id: string;
  content: string;
  timestamp: string;
  index: number;
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  messages: (Message & { toolCalls?: any[] })[];
  onScrollToMessage?: (messageId: string) => void;
}

export function PromptTimeline({ messages, onScrollToMessage }: PromptTimelineProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  const milestones = useMemo<PromptMilestone[]>(() => {
    let idx = 0;
    return messages
      .filter((m) => m.role === 'user' && m.content?.trim())
      .map((m) => ({
        id: m.id,
        content: m.content,
        timestamp: m.timestamp,
        index: idx++,
      }));
  }, [messages]);

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
        className="flex flex-col h-full w-[200px] flex-shrink-0 border-l border-border bg-muted/30 overflow-y-auto"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm border-b border-border px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <MessageCircle className="h-3 w-3" />
            {t('timeline.title', 'Prompts')}
          </div>
        </div>

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
                return (
                  <TimelineMilestone
                    key={ms.id}
                    milestone={ms}
                    isLast={isLast}
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

function TimelineMilestone({
  milestone,
  isLast,
  onScrollTo,
}: {
  milestone: PromptMilestone;
  isLast: boolean;
  onScrollTo?: (id: string) => void;
}) {
  return (
    <div className="flex gap-2 group/milestone">
      {/* Vertical line + dot */}
      <div className="flex flex-col items-center flex-shrink-0 w-4">
        <div
          className={cn(
            'w-2.5 h-2.5 rounded-full border-2 flex-shrink-0 mt-0.5 transition-colors',
            'border-primary/60 bg-background',
            'group-hover/milestone:border-primary group-hover/milestone:bg-primary/20'
          )}
        />
        {!isLast && (
          <div className="w-px flex-1 bg-border min-h-[16px]" />
        )}
      </div>

      {/* Content */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => onScrollTo?.(milestone.id)}
            className={cn(
              'flex-1 text-left pb-4 min-w-0 group/btn cursor-pointer',
              'hover:opacity-100 transition-opacity'
            )}
          >
            <div className="text-[10px] text-muted-foreground/50 font-mono tabular-nums mb-0.5">
              {formatTime(milestone.timestamp)}
            </div>
            <div className="text-[11px] text-muted-foreground leading-snug line-clamp-2 group-hover/btn:text-foreground transition-colors">
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
