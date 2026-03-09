import type { ThreadEvent } from '@funny/shared';

import type { CompactionEvent } from '@/stores/thread-store';

export type ToolItem =
  | { type: 'toolcall'; tc: any }
  | { type: 'toolcall-group'; name: string; calls: any[] };

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

export function buildGroupedRenderItems(
  messages: any[],
  threadEvents?: ThreadEvent[],
  compactionEvents?: CompactionEvent[],
): RenderItem[] {
  // Flatten all messages into a single stream of items
  const flat: ({ type: 'message'; msg: any } | { type: 'toolcall'; tc: any })[] = [];
  // Collect Write tool calls that wrote plan files, so ExitPlanMode can use their content
  let lastWrittenPlanContent: string | undefined;
  for (const msg of messages) {
    const hasExitPlanMode = msg.toolCalls?.some((tc: any) => tc.name === 'ExitPlanMode');
    // Only add message bubble if there's actual text content.
    // Skip if the message has an ExitPlanMode tool call — the plan text
    // will be shown inside the ExitPlanModeCard instead.
    if (msg.content && msg.content.trim() && !hasExitPlanMode) {
      flat.push({ type: 'message', msg });
    }
    for (const tc of msg.toolCalls ?? []) {
      // Track the most recent Write to a plan file (plan.md or ~/.claude/plans/*.md)
      if (tc.name === 'Write') {
        try {
          const inp = typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input;
          const fp = (inp?.file_path || '') as string;
          if (
            (/plan\.md$/i.test(fp) || /\.claude\/plans\/[^/]+\.md$/i.test(fp)) &&
            typeof inp?.content === 'string'
          ) {
            lastWrittenPlanContent = inp.content;
          }
        } catch {
          /* ignore parse errors */
        }
      }
      // Attach plan text for ExitPlanMode: prefer the content written to plan.md,
      // then fall back to the parent assistant message content
      if (tc.name === 'ExitPlanMode') {
        tc._planText = lastWrittenPlanContent || msg.content?.trim() || undefined;
      }
      flat.push({ type: 'toolcall', tc });
    }
  }

  // Tool calls that should never be grouped (interactive, need individual response, or need per-item scroll tracking)
  const noGroup = new Set(['AskUserQuestion', 'ExitPlanMode']);

  // Group consecutive same-type tool calls (across message boundaries)
  const grouped: RenderItem[] = [];
  for (const item of flat) {
    if (item.type === 'toolcall') {
      const last = grouped[grouped.length - 1];
      if (
        !noGroup.has(item.tc.name) &&
        last?.type === 'toolcall' &&
        (last as any).tc.name === item.tc.name
      ) {
        grouped[grouped.length - 1] = {
          type: 'toolcall-group',
          name: item.tc.name,
          calls: [(last as any).tc, item.tc],
        };
      } else if (
        !noGroup.has(item.tc.name) &&
        last?.type === 'toolcall-group' &&
        last.name === item.tc.name
      ) {
        last.calls.push(item.tc);
      } else {
        grouped.push(item);
      }
    } else {
      grouped.push(item);
    }
  }

  // Deduplicate TodoWrite: only keep the last one (the floating panel handles history).
  // For TodoWrite groups, replace with a single toolcall using the last call's data.
  let lastTodoIdx = -1;
  for (let i = grouped.length - 1; i >= 0; i--) {
    const g = grouped[i];
    if (
      (g.type === 'toolcall' && g.tc.name === 'TodoWrite') ||
      (g.type === 'toolcall-group' && g.name === 'TodoWrite')
    ) {
      lastTodoIdx = i;
      break;
    }
  }
  const deduped: RenderItem[] = [];
  for (let i = 0; i < grouped.length; i++) {
    const g = grouped[i];
    const isTodoItem =
      (g.type === 'toolcall' && g.tc.name === 'TodoWrite') ||
      (g.type === 'toolcall-group' && g.name === 'TodoWrite');
    if (isTodoItem && i !== lastTodoIdx) continue; // skip earlier TodoWrites
    if (isTodoItem && g.type === 'toolcall-group') {
      // Replace group with just the last call
      deduped.push({ type: 'toolcall', tc: g.calls[g.calls.length - 1] });
    } else {
      deduped.push(g);
    }
  }

  // Wrap consecutive tool call items into a single toolcall-run for tighter spacing
  const final: RenderItem[] = [];
  for (const item of deduped) {
    if (item.type === 'toolcall' || item.type === 'toolcall-group') {
      const last = final[final.length - 1];
      if (last?.type === 'toolcall-run') {
        last.items.push(item);
      } else if (last?.type === 'toolcall' || last?.type === 'toolcall-group') {
        final[final.length - 1] = { type: 'toolcall-run', items: [last, item] };
      } else {
        final.push(item);
      }
    } else {
      final.push(item);
    }
  }

  // Interleave thread events (git operations) and compaction events chronologically
  const hasEvents = threadEvents?.length || compactionEvents?.length;
  if (!hasEvents) return final;

  const filteredEvents = (threadEvents ?? []).filter(
    (e) => e.type !== 'git:changed' && e.type !== 'compact_boundary',
  );

  // Group workflow events: all events sharing the same workflowId become a
  // single workflow-event-group item. Git events (git:stage, git:commit, etc.)
  // carry the workflowId when emitted from a workflow pipeline.
  const eventItems: RenderItem[] = [];
  const workflowGroups = new Map<string, ThreadEvent[]>();
  const consumedEventIds = new Set<string>();

  // First pass: collect all events that carry a workflowId and group them
  for (const e of filteredEvents) {
    const data = parseEventDataCompat(e.data);
    const wfId = data.workflowId;
    if (wfId) {
      if (!workflowGroups.has(wfId)) workflowGroups.set(wfId, []);
      workflowGroups.get(wfId)!.push(e);
      consumedEventIds.add(e.id);
    }
  }

  // Sort events within each workflow group chronologically
  for (const [, events] of workflowGroups) {
    events.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }

  // Build render items: workflow groups + remaining individual events
  for (const [, events] of workflowGroups) {
    if (events.length > 0) {
      eventItems.push({ type: 'workflow-event-group' as const, events });
    }
  }

  for (const e of filteredEvents) {
    if (!consumedEventIds.has(e.id)) {
      eventItems.push({ type: 'thread-event' as const, event: e });
    }
  }

  const compactionItems: RenderItem[] = (compactionEvents ?? []).map((e) => ({
    type: 'compaction-event' as const,
    event: e,
  }));

  const merged = [...final, ...eventItems, ...compactionItems];
  merged.sort((a, b) => {
    const tsA = getItemTimestamp(a);
    const tsB = getItemTimestamp(b);
    if (!tsA && !tsB) return 0;
    if (!tsA) return -1;
    if (!tsB) return 1;
    return tsA.localeCompare(tsB);
  });

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
