import type { FileDiffSummary, ThreadEvent } from '@funny/shared';
import type { Ref, RefObject } from 'react';

import type { CompactionEvent } from '@/stores/thread-store';

export interface MemoizedMessageListHandle {
  expandToItem: (id: string) => void;
  hasHiddenItems: () => boolean;
  captureScrollAnchor: () => void;
  restoreScrollAnchor: (anchor?: MessageListScrollAnchor) => boolean;
  captureVisibleAnchor: () => MessageListScrollAnchor | null;
}

export interface MessageListScrollAnchor {
  key: string;
  offsetFromViewportTop: number;
}

export interface MemoizedMessageListProps {
  ref?: Ref<MemoizedMessageListHandle>;
  messages: any[];
  leadingUserMessage?: any;
  threadEvents?: ThreadEvent[];
  compactionEvents?: CompactionEvent[];
  threadId: string;
  threadStatus?: string;
  knownIds: Set<string>;
  snapshotMap: Map<string, number>;
  onSend: (prompt: string, opts: { model: string; mode: string }) => void;
  onOpenLightbox: (images: { src: string; alt: string }[], index: number) => void;
  onToolRespond?: (toolCallId: string, answer: string, toolName: string) => void;
  onFork?: (messageId: string) => void;
  onRewind?: (messageId: string) => void;
  onForkAndRewind?: (messageId: string) => void;
  forkingMessageId?: string | null;
  rewindDisabled?: boolean;
  rewindDisabledReason?: string;
  scrollRef: RefObject<HTMLElement | null>;
  /** Per-session changed files, keyed by the session's user-message id.
   *  Each entry renders a changed-files summary at the end of that session. */
  sessionChanges?: Map<string, FileDiffSummary[]>;
  /** Whether the agent is running (disables the latest session's revert). */
  changeSummaryRunning?: boolean;
  /** Called after a revert so the diff data refetches. */
  onSessionReverted?: () => void;
}
