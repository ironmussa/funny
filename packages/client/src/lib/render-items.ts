import type { ThreadEvent } from '@funny/shared';

import { isTodoToolName } from '@/components/tool-cards/utils';
import type { CompactionEvent } from '@/stores/thread-store';

import { isGitTimelineEventType } from './git-timeline-events';

export type ToolItem =
  | { type: 'toolcall'; tc: any }
  | { type: 'toolcall-group'; name: string; calls: any[] };

/** Tool calls that should never be grouped (interactive / need per-item tracking). */
const NO_GROUP = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Group consecutive tool calls with the same name into toolcall-group items. */
export function groupConsecutiveToolCalls(items: { tc: any }[]): ToolItem[] {
  const grouped: ToolItem[] = [];
  for (const item of items) {
    const { tc } = item;
    const last = grouped[grouped.length - 1];
    if (!NO_GROUP.has(tc.name)) {
      if (last?.type === 'toolcall' && last.tc.name === tc.name) {
        grouped[grouped.length - 1] = {
          type: 'toolcall-group',
          name: tc.name,
          calls: [last.tc, tc],
        };
        continue;
      }
      if (last?.type === 'toolcall-group' && last.name === tc.name) {
        last.calls.push(tc);
        continue;
      }
    }
    grouped.push({ type: 'toolcall', tc });
  }
  return grouped;
}

export type RenderItem =
  | { type: 'message'; msg: any }
  | ToolItem
  | { type: 'toolcall-run'; items: ToolItem[] }
  | { type: 'thread-event'; event: ThreadEvent }
  | { type: 'compaction-event'; event: CompactionEvent }
  | { type: 'workflow-event-group'; events: ThreadEvent[] };

/** Get timestamp for a render item (used for chronological interleaving with events) */
export function getItemTimestamp(item: RenderItem): string {
  if (item.type === 'message') return item.msg.timestamp || '';
  if (item.type === 'thread-event') return item.event.createdAt || '';
  if (item.type === 'compaction-event') return item.event.timestamp || '';
  if (item.type === 'toolcall') return item.tc.timestamp || '';
  if (item.type === 'toolcall-group') return item.calls[0]?.timestamp || '';
  if (item.type === 'toolcall-run') {
    const first = item.items[0];
    return first.type === 'toolcall' ? first.tc.timestamp || '' : first.calls[0]?.timestamp || '';
  }
  if (item.type === 'workflow-event-group') return item.events[0]?.createdAt || '';
  return '';
}

/** Get a stable key for a render item */
export function getItemKey(item: RenderItem): string {
  if (item.type === 'message') return item.msg.id;
  if (item.type === 'toolcall') return item.tc.id;
  if (item.type === 'toolcall-group') return item.calls[0].id;
  if (item.type === 'toolcall-run') {
    const first = item.items[0];
    return first.type === 'toolcall' ? first.tc.id : first.calls[0].id;
  }
  if (item.type === 'thread-event') return item.event.id;
  if (item.type === 'compaction-event') return `compact-${item.event.timestamp}`;
  if (item.type === 'workflow-event-group') return `workflow-${item.events[0]?.id}`;
  return '';
}

export type UserMessageRenderItem = Extract<RenderItem, { type: 'message' }>;

/** Build an id -> grouped-item-index map for imperative scroll/search targets. */
export function buildRenderItemIdIndexMap(items: RenderItem[]): Map<string, number> {
  const map = new Map<string, number>();

  const addToolItem = (item: ToolItem, index: number) => {
    if (item.type === 'toolcall') {
      map.set(item.tc.id, index);
      return;
    }
    for (const call of item.calls) {
      map.set(call.id, index);
    }
  };

  items.forEach((item, index) => {
    if (item.type === 'message') {
      map.set(item.msg.id, index);
    } else if (item.type === 'toolcall' || item.type === 'toolcall-group') {
      addToolItem(item, index);
    } else if (item.type === 'toolcall-run') {
      for (const toolItem of item.items) addToolItem(toolItem, index);
    } else if (item.type === 'thread-event') {
      map.set(item.event.id, index);
    } else if (item.type === 'workflow-event-group') {
      for (const event of item.events) map.set(event.id, index);
    }
  });

  return map;
}

/** Find the nearest user-message section owner before a grouped-item index. */
export function findNearestPrecedingUserMessageItem(
  items: RenderItem[],
  startIndex: number,
): UserMessageRenderItem | null {
  for (let i = Math.min(startIndex - 1, items.length - 1); i >= 0; i--) {
    const item = items[i];
    if (item.type === 'message' && item.msg.role === 'user') {
      return item;
    }
  }
  return null;
}

type FlatItem = { type: 'message'; msg: any } | { type: 'toolcall'; tc: any };

interface AgentRelations {
  /** IDs of Task/Agent tool calls present in the loaded messages. */
  loadedAgentIds: Set<string>;
  /** Child tool calls keyed by their parent Task/Agent tool call ID. */
  childrenByParent: Map<string, any[]>;
}

function isAgentToolName(name: string): boolean {
  return name === 'Task' || name === 'Agent';
}

/** Build a map of all tool calls by ID and collect child→parent relationships. */
function collectAgentRelations(messages: any[]): AgentRelations {
  const loadedAgentIds = new Set<string>();
  const childrenByParent = new Map<string, any[]>();
  for (const msg of messages) {
    for (const tc of msg.toolCalls ?? []) {
      if (isAgentToolName(tc.name)) loadedAgentIds.add(tc.id);
      if (tc.parentToolCallId) {
        const siblings = childrenByParent.get(tc.parentToolCallId) ?? [];
        siblings.push(tc);
        childrenByParent.set(tc.parentToolCallId, siblings);
      }
    }
  }
  return { loadedAgentIds, childrenByParent };
}

/** Plan files: `.plan`, `plan.md`, or `~/.claude/plans/*.md`. */
function isPlanFilePath(fp: string): boolean {
  return /\.plan$/i.test(fp) || /plan\.md$/i.test(fp) || /\.claude\/plans\/[^/]+\.md$/i.test(fp);
}

/** Return the content written by a Write tool call when it targets a plan file. */
function extractWrittenPlanContent(tc: any): string | undefined {
  try {
    const inp = typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input;
    const fp = (inp?.file_path || '') as string;
    if (isPlanFilePath(fp) && typeof inp?.content === 'string') return inp.content;
  } catch {
    /* ignore parse errors */
  }
  return undefined;
}

/**
 * Emit Think tool calls BEFORE the message text so the thinking appears above
 * the response in the UI (natural reading order). Also ensures every tool call
 * has a timestamp (falling back to the parent message).
 */
function pushThinkToolCalls(msg: any, relations: AgentRelations, flat: FlatItem[]): void {
  for (const tc of msg.toolCalls ?? []) {
    if (!tc.timestamp) tc.timestamp = msg.timestamp;
    if (tc.name === 'Think' && !relations.loadedAgentIds.has(tc.parentToolCallId)) {
      flat.push({ type: 'toolcall', tc });
    }
  }
}

/** Whether a tool call is rendered in the main (non-Think) tool-call pass. */
function isMainPassToolCall(tc: any, loadedAgentIds: Set<string>): boolean {
  // Think is already emitted before the message text.
  // EnterPlanMode carries no useful data (empty input) — the actual plan
  // content is rendered by ExitPlanMode.
  if (tc.name === 'Think' || tc.name === 'EnterPlanMode') return false;
  // Hide children only when their agent card is in the loaded page.
  // After refresh, pagination can leave the parent in an older page.
  return !loadedAgentIds.has(tc.parentToolCallId);
}

/**
 * Attach render-time annotations to a main-pass tool call. Returns the updated
 * "last written plan content" so ExitPlanMode can show it.
 */
function annotateToolCall(
  tc: any,
  msg: any,
  relations: AgentRelations,
  lastWrittenPlanContent: string | undefined,
): string | undefined {
  // Track the most recent Write to a plan file
  if (tc.name === 'Write') {
    lastWrittenPlanContent = extractWrittenPlanContent(tc) ?? lastWrittenPlanContent;
  }
  // Attach plan text for ExitPlanMode: prefer the content written to plan.md,
  // then fall back to the parent assistant message content
  if (tc.name === 'ExitPlanMode') {
    tc._planText = lastWrittenPlanContent || msg.content?.trim() || undefined;
  }
  // Attach child tool calls to Task tools for nested rendering
  if (isAgentToolName(tc.name) && relations.childrenByParent.has(tc.id)) {
    tc._childToolCalls = relations.childrenByParent.get(tc.id);
  }
  return lastWrittenPlanContent;
}

/**
 * Only add a message bubble if there's actual text content. Skip if the
 * message has an ExitPlanMode tool call — the plan text will be shown inside
 * the ExitPlanModeCard instead.
 */
function shouldRenderMessageBubble(msg: any, hasExitPlanMode: boolean): boolean {
  return Boolean(msg.content && msg.content.trim() && !hasExitPlanMode);
}

/** Flatten all messages into a single stream of message / toolcall items. */
function flattenMessages(messages: any[], relations: AgentRelations): FlatItem[] {
  const flat: FlatItem[] = [];
  // Collect Write tool calls that wrote plan files, so ExitPlanMode can use their content
  let lastWrittenPlanContent: string | undefined;
  for (const msg of messages) {
    const hasExitPlanMode = msg.toolCalls?.some((tc: any) => tc.name === 'ExitPlanMode');
    pushThinkToolCalls(msg, relations, flat);
    if (shouldRenderMessageBubble(msg, hasExitPlanMode)) {
      flat.push({ type: 'message', msg });
    }
    for (const tc of msg.toolCalls ?? []) {
      if (!isMainPassToolCall(tc, relations.loadedAgentIds)) continue;
      lastWrittenPlanContent = annotateToolCall(tc, msg, relations, lastWrittenPlanContent);
      flat.push({ type: 'toolcall', tc });
    }
  }
  return flat;
}

/**
 * Group consecutive same-type tool calls (across message boundaries).
 * Messages are kept in-order; only toolcall items get grouped.
 */
function groupFlatItems(flat: FlatItem[]): RenderItem[] {
  const grouped: RenderItem[] = [];
  let pendingToolCalls: { tc: any }[] = [];

  const flushToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      grouped.push(...groupConsecutiveToolCalls(pendingToolCalls));
      pendingToolCalls = [];
    }
  };

  for (const item of flat) {
    if (item.type === 'toolcall') {
      pendingToolCalls.push(item);
    } else {
      flushToolCalls();
      grouped.push(item);
    }
  }
  flushToolCalls();
  return grouped;
}

function isTodoRenderItem(g: RenderItem): boolean {
  return (
    (g.type === 'toolcall' && isTodoToolName(g.tc.name)) ||
    (g.type === 'toolcall-group' && isTodoToolName(g.name))
  );
}

/**
 * Deduplicate TodoWrite: only keep the last one (the floating panel handles history).
 * For TodoWrite groups, replace with a single toolcall using the last call's data.
 */
function dedupeTodoItems(grouped: RenderItem[]): RenderItem[] {
  let lastTodoIdx = -1;
  for (let i = grouped.length - 1; i >= 0; i--) {
    if (isTodoRenderItem(grouped[i])) {
      lastTodoIdx = i;
      break;
    }
  }
  const deduped: RenderItem[] = [];
  for (let i = 0; i < grouped.length; i++) {
    const g = grouped[i];
    const isTodoItem = isTodoRenderItem(g);
    if (isTodoItem && i !== lastTodoIdx) continue; // skip earlier TodoWrites
    if (isTodoItem && g.type === 'toolcall-group') {
      // Replace group with just the last call
      deduped.push({ type: 'toolcall', tc: g.calls[g.calls.length - 1] });
    } else {
      deduped.push(g);
    }
  }
  return deduped;
}

function isToolItem(item: RenderItem | undefined): item is ToolItem {
  return item?.type === 'toolcall' || item?.type === 'toolcall-group';
}

/** Wrap consecutive tool call items into a single toolcall-run for tighter spacing. */
function wrapToolCallRuns(items: RenderItem[]): RenderItem[] {
  const final: RenderItem[] = [];
  for (const item of items) {
    const last = final[final.length - 1];
    if (isToolItem(item) && last?.type === 'toolcall-run') {
      last.items.push(item);
    } else if (isToolItem(item) && isToolItem(last)) {
      final[final.length - 1] = { type: 'toolcall-run', items: [last, item] };
    } else {
      final.push(item);
    }
  }
  return final;
}

/** Whether a thread event gets its own timeline row. */
function isTimelineThreadEvent(e: ThreadEvent): boolean {
  return (
    // gRPC v2 persists durable agent lifecycle events for replay/auditing.
    // They have no timeline card, so including them would create invisible
    // virtual rows (and large blank gaps) between actual chat messages.
    !e.type.startsWith('agent:') &&
    e.type !== 'git:changed' &&
    e.type !== 'compact_boundary' &&
    // Consumed by ThreadChatView to render the per-session changed-files
    // summary at the end of each session — not as a standalone event card.
    e.type !== 'changed_files_summary'
  );
}

/**
 * Group workflow events: all events sharing the same workflowId become a
 * single workflow-event-group item. Git events (git:stage, git:commit, etc.)
 * carry the workflowId when emitted from a workflow pipeline. Remaining events
 * become individual thread-event items.
 */
function buildThreadEventItems(threadEvents: ThreadEvent[]): RenderItem[] {
  const filteredEvents = threadEvents.filter(isTimelineThreadEvent);
  const workflowGroups = new Map<string, ThreadEvent[]>();
  const consumedEventIds = new Set<string>();

  // First pass: collect all events that carry a workflowId and group them
  for (const e of filteredEvents) {
    const wfId = parseEventDataCompat(e.data).workflowId;
    if (!wfId) continue;
    if (!workflowGroups.has(wfId)) workflowGroups.set(wfId, []);
    workflowGroups.get(wfId)!.push(e);
    consumedEventIds.add(e.id);
  }

  const eventItems: RenderItem[] = [];
  // Build render items: workflow groups (sorted chronologically) + remaining individual events
  for (const [, events] of workflowGroups) {
    events.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    if (events.length > 0) {
      eventItems.push({ type: 'workflow-event-group' as const, events });
    }
  }

  for (const e of filteredEvents) {
    // Unrecognized standalone events render no card. Exclude them before
    // virtualization so they cannot leave empty rows and extra gaps.
    if (!consumedEventIds.has(e.id) && isGitTimelineEventType(e.type)) {
      eventItems.push({ type: 'thread-event' as const, event: e });
    }
  }
  return eventItems;
}

/** Chronological comparator; items without a timestamp sort first. */
function compareByTimestamp(a: RenderItem, b: RenderItem): number {
  const tsA = getItemTimestamp(a);
  const tsB = getItemTimestamp(b);
  if (!tsA && !tsB) return 0;
  if (!tsA) return -1;
  if (!tsB) return 1;
  return tsA.localeCompare(tsB);
}

export function buildGroupedRenderItems(
  messages: any[],
  threadEvents?: ThreadEvent[],
  compactionEvents?: CompactionEvent[],
): RenderItem[] {
  const relations = collectAgentRelations(messages);
  const flat = flattenMessages(messages, relations);
  const final = wrapToolCallRuns(dedupeTodoItems(groupFlatItems(flat)));

  // Interleave thread events (git operations) and compaction events chronologically
  const hasEvents = threadEvents?.length || compactionEvents?.length;
  if (!hasEvents) return final;

  const eventItems = buildThreadEventItems(threadEvents ?? []);
  const compactionItems: RenderItem[] = (compactionEvents ?? []).map((e) => ({
    type: 'compaction-event' as const,
    event: e,
  }));

  const merged = [...final, ...eventItems, ...compactionItems];
  merged.sort(compareByTimestamp);
  return merged;
}

/** Parse event data string or object */
function parseEventDataCompat(data: string | Record<string, unknown>): Record<string, any> {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  return data as Record<string, any>;
}
