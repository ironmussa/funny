// Thread comments, messages and tool calls (re-exported from `../types.js`).
import type { AgentModel } from '../models.js';
import type { EffortLevel, PermissionMode, WaitingReason } from '../primitives.js';
import type {
  PendingPermissionRequest,
  PermissionApprovalCapability,
} from './permission-approvals.js';
import type { Thread } from './thread.js';

// ─── Thread Comments ────────────────────────────────────

export type CommentSource = 'user' | 'system' | 'agent';

/** Author display info, joined onto a comment for rendering. */
export interface CommentAuthor {
  id: string;
  name: string | null;
  image: string | null;
  username: string | null;
}

export interface ThreadComment {
  id: string;
  threadId: string;
  userId: string;
  source: CommentSource;
  content: string;
  createdAt: string;
  /** Joined author display info (name/image). Populated by the comment routes. */
  user?: CommentAuthor | null;
}

// ─── Messages ────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ImageAttachment {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export interface Message {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  images?: ImageAttachment[];
  timestamp: string;
  /** Model used when this user message was sent */
  model?: AgentModel;
  /** Permission mode used when this user message was sent */
  permissionMode?: PermissionMode;
  /** Reasoning/effort level used when this user message was sent */
  effort?: EffortLevel;
  /** Agent name, pipeline name, or user identifier that produced this message */
  author?: string;
}

/**
 * `Message.author` of the prompt the runner sends on its own when it resumes a
 * thread its restart interrupted. The UI shows it as a resume marker, not as a
 * message the user wrote.
 */
export const AUTO_RESUME_MESSAGE_AUTHOR = 'funny:auto-resume';

// ─── Thread with Messages ────────────────────────────────

export interface ThreadWithMessages extends Thread {
  messages: (Message & { toolCalls?: ToolCall[] })[];
  hasMore?: boolean;
  hasMoreAfter?: boolean;
  /** Full message count for the thread; paired with windowStart to describe
   *  the loaded message window within the full history. */
  total?: number;
  /** Number of messages before the loaded window. */
  windowStart?: number;
  initInfo?: { tools: string[]; cwd: string; model: string; slashCommands?: string[] };
  /** Last user message — always included even when messages are paginated,
   *  so the UI can show the sticky prompt without loading all messages. */
  lastUserMessage?: Message & { toolCalls?: ToolCall[] };
  /** User message that owns the first loaded section when it sits before the
   *  paginated window. Used as sticky section context without extending
   *  `messages`. */
  leadingUserMessage?: Message & { toolCalls?: ToolCall[] };
  /** Number of messages currently queued for this thread. */
  queuedCount?: number;
  /** Preview/content of the next queued message. */
  queuedNextMessage?: string;
  /** Waiting subtype reconstructed from persisted tool calls when status is waiting. */
  waitingReason?: WaitingReason;
  /** Pending tool approval reconstructed from persisted tool calls. */
  pendingPermission?: { toolName: string; toolInput?: string };
  /** A live, structured approval request when the transport supports it. */
  pendingPermissionRequest?: PendingPermissionRequest;
  /** The effective permission interaction capability for this thread. */
  permissionApprovalCapability?: PermissionApprovalCapability;
}

export interface PaginatedMessages {
  messages: (Message & { toolCalls?: ToolCall[] })[];
  hasMore: boolean;
  hasMoreAfter?: boolean;
  /** Full message count for the thread. */
  total?: number;
  /** Number of messages before the loaded window. */
  windowStart?: number;
  /** User message that owns the first loaded section when it sits before the
   *  paginated window. Used as sticky section context without extending
   *  `messages`. */
  leadingUserMessage?: Message & { toolCalls?: ToolCall[] };
}

// ─── Tool Calls ──────────────────────────────────────────

export interface ToolCall {
  id: string;
  messageId: string;
  name: string;
  input: string;
  output?: string;
  /** Event timestamp used by the client to interleave tool cards chronologically. */
  timestamp?: string;
  /** Agent name that executed this tool call (for pipeline threads) */
  author?: string;
  /** Links subagent tool calls to their parent Task tool call */
  parentToolCallId?: string;
}
