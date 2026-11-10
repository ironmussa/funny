/**
 * `/api/threads` contract for the routes the server answers from its own DB:
 * the lists, the detail view, and the field updates. Creation, fork and the
 * agent operations are proxied to the runner and are not covered here.
 */

import { z } from 'zod';

import type { PermissionMode, ThreadMode, ThreadStage, ThreadStatus } from '../primitives.js';
import type { PaginatedMessages, PaginatedThreadsResponse, ThreadWithMessages } from '../types.js';
import type { Thread } from '../types/thread.js';
import { endpointGroup } from './endpoint.js';

/**
 * Every value of the union `U`, as a tuple: an extra value or a missing one is
 * a compile error, so the zod enums cannot fall behind the types.
 */
const allOf =
  <U extends string>() =>
  <const T extends readonly [U, ...U[]]>(
    values: T & ([U] extends [T[number]] ? unknown : 'missing a value of the union'),
  ): T =>
    values;

export const THREAD_STATUS_VALUES = allOf<ThreadStatus>()([
  'setting_up',
  'idle',
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'stopped',
  'interrupted',
]);

export const THREAD_STAGE_VALUES = allOf<ThreadStage>()([
  'backlog',
  'planning',
  'in_progress',
  'review',
  'done',
  'archived',
]);

export const PERMISSION_MODE_VALUES = allOf<PermissionMode>()([
  'plan',
  'auto',
  'autoEdit',
  'confirmEdit',
  'ask',
]);

const THREAD_MODE_VALUES = allOf<ThreadMode>()(['local', 'worktree']);

// ── Query helpers ────────────────────────────────────────────────
// List queries have always clamped out-of-range paging instead of refusing it,
// and read flags as the literal string "true"; these keep that behavior.

/** An integer clamped to [min, max]; missing or unparsable gives `fallback`. */
const clampedInt = (fallback: number, min: number, max: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      const n = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
    });

/** True only for `true` / `"true"`. */
const queryFlag = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => value === true || value === 'true');

const listQuery = z.object({
  projectId: z.string().optional(),
  designId: z.string().optional(),
  includeArchived: queryFlag,
  isScratch: queryFlag,
  limit: clampedInt(50, 1, 200),
  offset: clampedInt(0, 0, Number.MAX_SAFE_INTEGER),
});

const scratchQuery = z.object({
  limit: clampedInt(50, 1, 200),
  offset: clampedInt(0, 0, Number.MAX_SAFE_INTEGER),
});

const archivedQuery = z.object({
  page: clampedInt(1, 1, Number.MAX_SAFE_INTEGER),
  limit: clampedInt(100, 1, 1000),
  search: z.string().optional(),
  projectId: z.string().optional(),
});

const messagesQuery = z.object({
  cursor: z.string().optional(),
  limit: clampedInt(50, 1, 200),
  // Anything but "after" has always meant "before".
  direction: z
    .unknown()
    .optional()
    .transform((value): 'before' | 'after' => (value === 'after' ? 'after' : 'before')),
});

const messageSearchQuery = z.object({
  q: z.string().optional(),
  limit: clampedInt(100, 1, 200),
  caseSensitive: queryFlag,
});

const contentSearchQuery = z.object({
  q: z.string().optional(),
  projectId: z.string().optional(),
  caseSensitive: queryFlag,
});

export interface MessageSearchResult {
  messageId: string;
  role: string;
  content: string;
  timestamp: string;
  snippet: string;
}

const detailQuery = z.object({
  messageLimit: z.coerce.number().int().min(1).max(200).optional(),
  messageProgress: z.coerce.number().min(0).max(1).optional(),
  messageAnchorId: z.string().min(1).optional(),
});

// ── Bodies ───────────────────────────────────────────────────────

// Security CR-4: `worktreePath` is intentionally NOT writable. It is set only
// by the runtime's `createWorktree` flow and names a directory the runner
// trusts as an agent cwd. Unknown keys are dropped, as before, but every
// accepted key now has a type.
export const threadPatchBody = z.object({
  title: z.string().optional(),
  status: z.enum(THREAD_STATUS_VALUES).optional(),
  stage: z.enum(THREAD_STAGE_VALUES).optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  schedulerManaged: z.boolean().optional(),
  model: z.string().min(1).optional(),
  mode: z.enum(THREAD_MODE_VALUES).optional(),
  branch: z.string().nullable().optional(),
  baseBranch: z.string().nullable().optional(),
  permissionMode: z.enum(PERMISSION_MODE_VALUES).optional(),
  provider: z.string().min(1).optional(),
});

const permissionModeBody = z.object({ permissionMode: z.enum(PERMISSION_MODE_VALUES) });

/** `{ value, reason }` for the pipeline DSL's `set_status` / `set_stage` actions. */
const lifecycleValueBody = <const T extends readonly [string, ...string[]]>(
  field: string,
  values: T,
) =>
  z.object({
    value: z.enum(values, {
      error: (issue) =>
        typeof issue.input === 'string'
          ? `Invalid ${field} "${issue.input}". Allowed: ${values.join(', ')}`
          : 'Missing required string field "value"',
    }),
    // A non-string reason has always been ignored rather than refused.
    reason: z
      .unknown()
      .optional()
      .transform((reason) => (typeof reason === 'string' ? reason : undefined)),
  });

export type ThreadPatchRequest = z.input<typeof threadPatchBody>;

export interface ArchivedThreadsResponse {
  threads: Thread[];
  total: number;
  page: number;
  limit: number;
}

const api = endpointGroup('/threads');

export const threadsContract = {
  // Static segments are declared before `/:id` so they are not read as ids.
  list: api.endpoint<PaginatedThreadsResponse>()({ method: 'GET', path: '/', query: listQuery }),
  scratch: api.endpoint<PaginatedThreadsResponse>()({
    method: 'GET',
    path: '/scratch',
    query: scratchQuery,
  }),
  archived: api.endpoint<ArchivedThreadsResponse>()({
    method: 'GET',
    path: '/archived',
    query: archivedQuery,
  }),
  get: api.endpoint<ThreadWithMessages>()({ method: 'GET', path: '/:id', query: detailQuery }),
  update: api.endpoint<Thread>()({ method: 'PATCH', path: '/:id', body: threadPatchBody }),
  setPermissionMode: api.endpoint<Thread>()({
    method: 'PATCH',
    path: '/:id/permission-mode',
    body: permissionModeBody,
  }),
  setStatus: api.endpoint<Thread>()({
    method: 'PATCH',
    path: '/:id/status',
    body: lifecycleValueBody('status', THREAD_STATUS_VALUES),
  }),
  setStage: api.endpoint<Thread>()({
    method: 'PATCH',
    path: '/:id/stage',
    body: lifecycleValueBody('stage', THREAD_STAGE_VALUES),
  }),
  messages: api.endpoint<PaginatedMessages>()({
    method: 'GET',
    path: '/:id/messages',
    query: messagesQuery,
  }),
  searchMessages: api.endpoint<{ results: MessageSearchResult[] }>()({
    method: 'GET',
    path: '/:id/messages/search',
    query: messageSearchQuery,
  }),
  searchContent: api.endpoint<{ threadIds: string[]; snippets: Record<string, string> }>()({
    method: 'GET',
    path: '/search/content',
    query: contentSearchQuery,
  }),
};
