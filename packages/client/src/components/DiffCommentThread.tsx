import type { PRReviewThread } from '@funny/shared';
import { CheckCircle2, Clock, MessageSquare } from 'lucide-react';

import { cn } from '@/lib/utils';

interface DiffCommentThreadProps {
  thread: PRReviewThread;
  className?: string;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function DiffCommentThread({ thread, className }: DiffCommentThreadProps) {
  return (
    <div
      className={cn(
        'max-h-80 w-80 overflow-y-auto rounded-lg border border-border bg-background p-3 shadow-lg',
        className,
      )}
      data-testid={`comment-thread-${thread.id}`}
    >
      {/* Thread header */}
      <div className="mb-2 flex items-center gap-2 text-[10px] text-muted-foreground">
        <MessageSquare className="h-3 w-3" />
        <span className="font-mono">{thread.path}</span>
        {thread.line && <span>line {thread.line}</span>}
        <div className="flex-1" />
        {thread.is_resolved && (
          <span className="flex items-center gap-0.5 text-green-400">
            <CheckCircle2 className="h-3 w-3" /> Resolved
          </span>
        )}
        {thread.is_outdated && (
          <span className="flex items-center gap-0.5 text-yellow-400">
            <Clock className="h-3 w-3" /> Outdated
          </span>
        )}
      </div>

      {/* Comments */}
      <div className="space-y-2">
        {thread.comments.map((comment) => (
          <div
            key={comment.id}
            className="rounded-md border border-border/50 p-2"
            data-testid={`comment-${comment.id}`}
          >
            <div className="mb-1 flex items-center gap-1.5">
              {comment.author_avatar_url && (
                <img
                  src={comment.author_avatar_url}
                  alt={comment.author}
                  className="h-4 w-4 rounded-full"
                />
              )}
              <span className="text-[11px] font-medium">{comment.author}</span>
              {comment.author_association && comment.author_association !== 'NONE' && (
                <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
                  {comment.author_association.toLowerCase()}
                </span>
              )}
              <span className="ml-auto text-[10px] text-muted-foreground">
                {formatRelativeTime(comment.created_at)}
              </span>
            </div>
            <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/90">
              {comment.body}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
