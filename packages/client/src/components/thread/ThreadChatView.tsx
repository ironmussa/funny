import { useEffect, useRef, useState } from 'react';

import { PipelineProgressBanner } from '@/components/PipelineProgressBanner';
import { type MessageStreamHandle } from '@/components/thread/MessageStream';
import { PromptTimeline } from '@/components/thread/PromptTimeline';
import { ThreadConversation } from '@/components/thread/ThreadConversation';
import { ThreadSearchBar } from '@/components/thread/ThreadSearchBar';
import { useThreadSearchState } from '@/hooks/use-thread-search';
import { useThreadMessages, type ThreadCore } from '@/stores/thread-context';
import { useUIStore } from '@/stores/ui-store';

type ActiveThread = ThreadCore;

interface Props {
  activeThread: ActiveThread;
}

export function ThreadChatView({ activeThread }: Props) {
  const stableMessages = useThreadMessages();
  const timelineVisible = useUIStore((s) => s.timelineVisible);
  const streamRef = useRef<MessageStreamHandle>(null);
  const [visibleMessageId, setVisibleMessageId] = useState<string | null>(null);

  const { searchOpen, setSearchOpen, handleSearchNavigate, handleSearchClose } =
    useThreadSearchState(streamRef, activeThread.id);

  // Search handoff from the list/board views: arriving at a thread via a
  // search-result click opens the in-thread search pre-filled with that
  // query. ThreadSearchBar consumes (and clears) the pending entry itself.
  const pendingThreadSearch = useUIStore((s) => s.pendingThreadSearch);
  useEffect(() => {
    if (pendingThreadSearch && pendingThreadSearch.threadId === activeThread.id) {
      setSearchOpen(true);
    }
  }, [pendingThreadSearch, activeThread.id, setSearchOpen]);

  // Global Ctrl+F opens the per-thread search in the main chat view. Scoped
  // to the active thread; the grid view has its own per-column handler.
  useEffect(() => {
    if (!activeThread.id) return;
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
      if (e.key !== 'f' && e.key !== 'F') return;
      // Don't hijack Ctrl+F when focus is inside a terminal — the
      // terminal owns this shortcut and shows its own search overlay.
      const target = e.target as Element | null;
      if (target && target.closest('.xterm')) return;
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
      const input = document.querySelector<HTMLInputElement>('[data-testid="thread-search-input"]');
      if (input) requestAnimationFrame(() => input.focus());
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [activeThread.id, setSearchOpen]);

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      {activeThread.id && <PipelineProgressBanner threadId={activeThread.id} />}
      <div className="thread-container flex min-h-0 flex-1">
        <ThreadConversation
          streamRef={streamRef}
          enablePagination
          onVisibleMessageChange={setVisibleMessageId}
          searchBar={
            <ThreadSearchBar
              threadId={activeThread.id}
              open={searchOpen}
              onClose={handleSearchClose}
              onNavigateToMessage={handleSearchNavigate}
            />
          }
        />
        {timelineVisible && stableMessages && stableMessages.length > 0 && (
          <PromptTimeline
            messages={stableMessages}
            activeMessageId={
              visibleMessageId ??
              activeThread.lastUserMessage?.id ??
              stableMessages.filter((m) => m.role === 'user' && m.content?.trim()).at(-1)?.id
            }
            threadStatus={activeThread.status}
            messagesScrollRef={{ current: streamRef.current?.scrollViewport ?? null }}
            onScrollToMessage={(msgId, toolCallId) => {
              const targetId = toolCallId || msgId;
              const selector = toolCallId
                ? `[data-tool-call-id="${toolCallId}"]`
                : `[data-user-msg="${msgId}"]`;
              const viewport = streamRef.current?.scrollViewport;
              const el = viewport?.querySelector(selector);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              } else {
                streamRef.current?.expandToItem(targetId);
                requestAnimationFrame(() => {
                  const el2 = streamRef.current?.scrollViewport?.querySelector(selector);
                  if (el2) el2.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
