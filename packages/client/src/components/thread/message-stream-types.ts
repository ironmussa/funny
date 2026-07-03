import type { ThreadEvent, WaitingReason } from '@funny/shared';
import type { ReactNode, Ref } from 'react';

import type { AgentInitInfo, CompactionEvent } from '@/stores/thread-store';

export interface MessageStreamProps {
  ref?: Ref<MessageStreamHandle>;
  threadId: string;
  status: string;
  messages: any[];
  leadingUserMessage?: any;
  threadEvents?: ThreadEvent[];
  compactionEvents?: CompactionEvent[];
  initInfo?: AgentInitInfo;
  resultInfo?: { status: 'completed' | 'failed'; cost: number; duration: number; error?: string };
  waitingReason?: WaitingReason;
  pendingPermission?: { toolName: string; toolInput?: string };
  isExternal?: boolean;
  onSend: (prompt: string, opts: { model: string; mode: string }) => void;
  onPermissionApproval?: (toolName: string, approved: boolean, alwaysAllow?: boolean) => void;
  onToolRespond?: (toolCallId: string, answer: string, toolName: string) => void;
  onFork?: (messageId: string) => void;
  onRewind?: (messageId: string) => void;
  onForkAndRewind?: (messageId: string) => void;
  forkingMessageId?: string | null;
  rewindDisabled?: boolean;
  rewindDisabledReason?: string;
  model?: string;
  permissionMode?: string;
  sessionChanges?: Map<string, import('@funny/shared').FileDiffSummary[]>;
  onSessionReverted?: () => void;
  pagination?: {
    hasMore: boolean;
    hasMoreAfter?: boolean;
    loadingMore: boolean;
    load: () => void;
    loadAfter?: () => void;
    total?: number;
    windowStart?: number;
  };
  createdAt?: string;
  snapshotMap?: Map<string, number>;
  knownIds?: Set<string>;
  onOpenLightbox?: (images: { src: string; alt: string }[], index: number) => void;
  onVisibleMessageChange?: (id: string) => void;
  compact?: boolean;
  footer?: ReactNode;
  prefersReducedMotion?: boolean | null;
  className?: string;
}

export interface MessageStreamHandle {
  scrollToBottom: () => void;
  scrollViewport: HTMLDivElement | null;
  expandToItem: (id: string) => void;
  hasHiddenItems: () => boolean;
  captureScrollAnchor: () => void;
  restoreScrollAnchor: () => void;
}
