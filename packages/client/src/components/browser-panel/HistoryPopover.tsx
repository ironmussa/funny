import { History } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { cn } from '@/lib/utils';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { useProjectStore } from '@/stores/project-store';

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function HistoryPopover() {
  const history = useBrowserPanelStore((s) => s.sentHistory);
  const clearSentHistory = useBrowserPanelStore((s) => s.clearSentHistory);
  const closePanel = useBrowserPanelStore((s) => s.closePanel);
  const projects = useProjectStore((s) => s.projects);
  const navigate = useStableNavigate();

  const [open, setOpen] = useState(false);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? '(unknown)';

  const goToThread = (threadId: string) => {
    setOpen(false);
    closePanel();
    navigate(`/threads/${threadId}`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              data-testid="browser-panel-history"
              className={cn('text-muted-foreground')}
            >
              <History className="icon-base" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Sent history</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="end" className="w-80 p-0">
        <div className="border-border flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Sent history</span>
          {history.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="browser-panel-history-clear"
              onClick={clearSentHistory}
              className="text-muted-foreground h-6 px-2 text-xs"
            >
              Clear
            </Button>
          )}
        </div>
        {history.length === 0 ? (
          <div
            className="text-muted-foreground px-3 py-6 text-center text-sm"
            data-testid="browser-panel-history-empty"
          >
            No threads sent yet.
          </div>
        ) : (
          <ScrollArea className="max-h-72">
            <ul className="divide-border flex flex-col divide-y">
              {history.map((entry) => (
                <li key={entry.threadId}>
                  <button
                    type="button"
                    data-testid={`browser-panel-history-item-${entry.threadId}`}
                    onClick={() => goToThread(entry.threadId)}
                    className="hover:bg-muted flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors"
                  >
                    <span className="truncate text-sm">{entry.title}</span>
                    <span className="text-muted-foreground text-xs">
                      {projectName(entry.projectId)} · {entry.annotationCount} annotation
                      {entry.annotationCount === 1 ? '' : 's'} · {timeAgo(entry.sentAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
