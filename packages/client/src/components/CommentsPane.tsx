import { MessageSquare, Send, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { timeAgo } from '@/lib/thread-utils';
import { useAuthStore } from '@/stores/auth-store';
import { useCommentStore } from '@/stores/comment-store';
import { useThreadSelector } from '@/stores/thread-context';

/**
 * Docked Comments panel for a thread (right pane, `rightPaneTab === 'comments'`).
 * A flat, thread-level discussion shared by the owner and every sharee — opened
 * from the 💬 header icon, the sibling of the file-manager pane. Both owner and
 * sharee can read and post; only the owner can delete (mirrors the server's
 * `requireThreadOwner` gate on DELETE). Live appends arrive via the
 * `thread:comment` WS event through the comment-store.
 */
export function CommentsPane() {
  const { t } = useTranslation();
  const threadId = useThreadSelector((th) => th?.id ?? null);
  const ownerId = useThreadSelector((th) => th?.userId ?? null);
  const selfId = useAuthStore((s) => s.user?.id ?? null);
  const isOwner = !!selfId && ownerId === selfId;

  const comments = useCommentStore((s) => (threadId ? (s.byThread[threadId] ?? null) : null));
  const loading = useCommentStore((s) => (threadId ? !!s.loadingByThread[threadId] : false));
  const fetch = useCommentStore((s) => s.fetch);
  const post = useCommentStore((s) => s.post);
  const remove = useCommentStore((s) => s.remove);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (threadId) void fetch(threadId);
  }, [threadId, fetch]);

  // Keep the newest comment in view as the list grows.
  const count = comments?.length ?? 0;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  const canSend = draft.trim().length > 0 && !sending && !!threadId;

  const submit = async () => {
    if (!canSend || !threadId) return;
    setSending(true);
    const ok = await post(threadId, draft);
    setSending(false);
    if (ok) setDraft('');
  };

  const header = useMemo(
    () => (
      <div className="border-border flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <MessageSquare className="text-muted-foreground h-4 w-4" />
        <span className="text-sm font-medium">{t('comments.title', 'Comments')}</span>
        {count > 0 && <span className="text-muted-foreground text-xs">{count}</span>}
      </div>
    ),
    [t, count],
  );

  if (!threadId) {
    return (
      <div className="bg-sidebar flex h-full w-full flex-col" data-testid="comments-pane">
        {header}
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
          {t('comments.noThread', 'No thread selected')}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-sidebar flex h-full w-full flex-col" data-testid="comments-pane">
      {header}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3" data-testid="comments-list">
          {loading && count === 0 ? (
            <p className="text-muted-foreground text-sm">{t('comments.loading', 'Loading…')}</p>
          ) : count === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-1 py-10 text-center text-sm">
              <MessageSquare className="h-6 w-6 opacity-50" />
              <p>{t('comments.empty', 'No comments yet')}</p>
              <p className="text-xs">{t('comments.emptyHint', 'Leave the first note below.')}</p>
            </div>
          ) : (
            comments!.map((c) => {
              const name = c.user?.name ?? c.user?.username ?? c.userId;
              const mine = c.userId === selfId;
              return (
                <div key={c.id} className="group flex gap-2" data-testid={`comment-row-${c.id}`}>
                  <Avatar className="mt-0.5 h-7 w-7 shrink-0">
                    {c.user?.image && <AvatarImage src={c.user.image} alt={name} />}
                    <AvatarFallback name={name} className="text-xs">
                      {name.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">
                        {mine ? t('comments.you', '{{name}} (you)', { name }) : name}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {timeAgo(c.createdAt, t)}
                      </span>
                      {isOwner && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-status-danger ml-auto h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                          onClick={() => void remove(threadId, c.id)}
                          data-testid={`comment-delete-${c.id}`}
                          aria-label={t('comments.delete', 'Delete comment')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                    <p className="text-sm break-words whitespace-pre-wrap">{c.content}</p>
                  </div>
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <div className="border-border flex shrink-0 items-end gap-2 border-t p-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={t('comments.placeholder', 'Write a comment…')}
          className="max-h-32 min-h-9 resize-none text-sm"
          rows={1}
          data-testid="comment-input"
        />
        <Button
          size="icon"
          disabled={!canSend}
          onClick={() => void submit()}
          data-testid="comment-send"
          aria-label={t('comments.send', 'Send comment')}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
