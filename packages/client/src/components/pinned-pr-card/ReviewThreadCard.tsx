import type { PRReviewThread } from '@funny/shared';
import { CheckCircle2, CircleDot, Loader2, Reply, Send, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { EditableComment } from './PRComments';
import type { PRCommentActions, PRThreadActions } from './use-pr-comment-actions';

interface ReviewThreadCardProps {
  th: PRReviewThread;
  now: number;
  currentUserLogin: string | undefined;
  commentActions: PRCommentActions;
  threadActions: PRThreadActions;
}

function ThreadReplyForm({
  th,
  threadActions,
}: Pick<ReviewThreadCardProps, 'th' | 'threadActions'>) {
  const { replyBody, setReplyBody, setReplyForThread, replyingThread, handleReply } = threadActions;
  return (
    <div className="flex flex-col gap-1.5 pl-3">
      <label
        className="text-muted-foreground text-xs font-medium"
        htmlFor={`pinned-pr-thread-reply-${th.id}`}
      >
        Reply
      </label>
      <textarea
        id={`pinned-pr-thread-reply-${th.id}`}
        className="border-border bg-background focus:ring-ring w-full rounded-md border p-2 text-xs focus:ring-1 focus:outline-hidden"
        rows={2}
        value={replyBody}
        onChange={(e) => setReplyBody(e.target.value)}
        placeholder="Reply…"
        data-testid={`pinned-pr-thread-reply-textarea-${th.id}`}
      />
      <div className="flex justify-end gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            setReplyForThread(null);
            setReplyBody('');
          }}
          data-testid={`pinned-pr-thread-reply-cancel-${th.id}`}
        >
          <X className="icon-xs" />
        </Button>
        <Button
          size="xs"
          disabled={!replyBody.trim() || replyingThread}
          onClick={() => handleReply(th)}
          data-testid={`pinned-pr-thread-reply-send-${th.id}`}
        >
          {replyingThread ? (
            <Loader2 className="icon-xs animate-spin" />
          ) : (
            <Send className="icon-xs" />
          )}
        </Button>
      </div>
    </div>
  );
}

/** One review thread: line, resolve toggle, its comments and the reply box. */
export function ReviewThreadCard({
  th,
  now,
  currentUserLogin,
  commentActions,
  threadActions,
}: ReviewThreadCardProps) {
  const { resolvingNodeId, handleResolve, replyForThread, setReplyForThread, setReplyBody } =
    threadActions;
  const resolving = resolvingNodeId === th.node_id;
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-md border p-2',
        th.is_resolved
          ? 'border-border/40 bg-background/50 opacity-70'
          : 'border-border bg-background',
      )}
      data-testid={`pinned-pr-thread-${th.id}`}
    >
      <div className="text-muted-foreground text-2xs flex items-center gap-1.5">
        {th.is_resolved ? (
          <CheckCircle2 className="text-status-success size-3" />
        ) : (
          <CircleDot className="size-3" />
        )}
        <span>
          Line {th.line ?? th.original_line ?? '?'}
          {th.is_outdated ? ' (outdated)' : ''}
        </span>
        <div className="flex-1" />
        {th.node_id && (
          <Button
            variant="ghost"
            size="3xs"
            gap="tight"
            disabled={resolving}
            onClick={() => handleResolve(th)}
            data-testid={`pinned-pr-thread-resolve-${th.id}`}
          >
            {resolving ? (
              <Loader2 className="icon-xs animate-spin" />
            ) : th.is_resolved ? (
              'Unresolve'
            ) : (
              'Resolve'
            )}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {th.comments.map((c, idx) => (
          <div key={c.id} className={cn('flex flex-col gap-1', idx !== 0 && 'pl-3')}>
            <EditableComment
              kind="review"
              c={c}
              testPrefix="pinned-pr-review"
              now={now}
              currentUserLogin={currentUserLogin}
              actions={commentActions}
            />
          </div>
        ))}
      </div>
      {replyForThread === th.id ? (
        <ThreadReplyForm th={th} threadActions={threadActions} />
      ) : (
        <div className="pl-3">
          <Button
            variant="ghost"
            size="3xs"
            gap="tight"
            onClick={() => {
              setReplyForThread(th.id);
              setReplyBody('');
            }}
            data-testid={`pinned-pr-thread-reply-open-${th.id}`}
          >
            <Reply className="icon-xs" />
            Reply
          </Button>
        </div>
      )}
    </div>
  );
}
