/**
 * ThreadEventsPanel — Displays git events (commits, pushes, merges) for a thread.
 */

import type { ThreadEvent } from '@funny/shared';
import { GitCommit, GitMerge, Upload, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ThreadEventsPanelProps {
  threadId: string;
}

function formatTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

function EventIcon({ type }: { type: ThreadEvent['type'] }) {
  switch (type) {
    case 'git:commit':
      return <GitCommit className="h-4 w-4" />;
    case 'git:push':
      return <Upload className="h-4 w-4" />;
    case 'git:merge':
      return <GitMerge className="h-4 w-4" />;
    default:
      return null;
  }
}

function EventBadge({ type }: { type: ThreadEvent['type'] }) {
  switch (type) {
    case 'git:commit':
      return (
        <Badge variant="outline" className="text-xs">
          Commit
        </Badge>
      );
    case 'git:push':
      return (
        <Badge
          variant="outline"
          className="border-blue-500/20 bg-blue-500/10 text-xs text-blue-600"
        >
          Push
        </Badge>
      );
    case 'git:merge':
      return (
        <Badge
          variant="outline"
          className="border-purple-500/20 bg-purple-500/10 text-xs text-purple-600"
        >
          Merge
        </Badge>
      );
    default:
      return null;
  }
}

function parseEventData(data: string): Record<string, any> {
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export function ThreadEventsPanel({ threadId }: ThreadEventsPanelProps) {
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const fetchEvents = async () => {
      setLoading(true);
      const result = await api.getThreadEvents(threadId);
      if (mounted && result.isOk()) {
        setEvents(result.value.events);
      }
      if (mounted) {
        setLoading(false);
      }
    };

    fetchEvents();

    return () => {
      mounted = false;
    };
  }, [threadId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
        No git events yet
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-4">
        {events.map((event) => {
          const metadata = parseEventData(event.data);
          return (
            <div
              key={event.id}
              className={cn(
                'flex gap-3 p-3 rounded-lg border bg-card text-card-foreground',
                'hover:bg-accent/50 transition-colors',
              )}
            >
              <div className="mt-0.5 shrink-0">
                <EventIcon type={event.type} />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <EventBadge type={event.type} />
                  <span className="text-xs text-muted-foreground">
                    {formatTimestamp(event.createdAt)}
                  </span>
                </div>
                {Object.keys(metadata).length > 0 && (
                  <div className="space-y-1 text-sm">
                    {metadata.message && (
                      <div className="font-medium text-foreground">{metadata.message}</div>
                    )}
                    {metadata.commitSha && (
                      <div className="font-mono text-xs text-muted-foreground">
                        {metadata.commitSha.substring(0, 7)}
                      </div>
                    )}
                    {metadata.branch && (
                      <div className="text-xs text-muted-foreground">
                        Branch: <span className="font-mono">{metadata.branch}</span>
                      </div>
                    )}
                    {metadata.sourceBranch && metadata.targetBranch && (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-mono">{metadata.sourceBranch}</span>
                        {' → '}
                        <span className="font-mono">{metadata.targetBranch}</span>
                      </div>
                    )}
                    {metadata.conflictResolution && (
                      <Badge
                        variant="outline"
                        className="border-yellow-500/20 bg-yellow-500/10 text-xs text-yellow-600"
                      >
                        Conflicts resolved
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
