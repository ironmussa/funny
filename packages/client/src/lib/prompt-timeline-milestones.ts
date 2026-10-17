import type { Message, ThreadStatus, ToolCall } from '@funny/shared';

/**
 * Pure computation of the milestones shown in the thread's PromptTimeline:
 * a start marker, user prompts, TodoWrite tasks (one per task, emitted at the
 * snapshot where it first appeared, with its latest status), questions, plans
 * and an end marker for finished threads.
 */

export type MilestoneType = 'prompt' | 'todo' | 'question' | 'plan' | 'start' | 'end';

export interface PromptMilestone {
  id: string;
  content: string;
  timestamp: string;
  index: number;
  type: MilestoneType;
  /** Tool call ID for scrolling to tool call elements */
  toolCallId?: string;
  /** Whether this individual todo task is completed */
  completed?: boolean;
  /** Whether this individual todo task is currently in progress */
  inProgress?: boolean;
}

export type TimelineMessage = Message & { toolCalls?: ToolCall[] };

type MilestoneDraft = Omit<PromptMilestone, 'index'>;

interface TodoItem {
  content?: string;
  activeForm?: string;
  status?: string;
}

interface TodoSnapshot {
  todos: TodoItem[];
  toolCallId: string;
  timestamp: string;
}

interface TodoIndex {
  /** Number of todos in the latest snapshot (for step numbering) */
  total: number;
  firstSeen: Map<string, { timestamp: string; toolCallId: string; snapshotIdx: number }>;
  latest: Map<string, TodoItem>;
  /** Todo keys of the latest snapshot, grouped by the snapshot they first appeared in */
  byFirstSnapshot: Map<number, string[]>;
  snapshotIndexByToolCallId: Map<string, number>;
}

const END_LABELS: Partial<Record<ThreadStatus, string>> = {
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
};

const TOOL_CALL_TYPES: Record<string, MilestoneType> = {
  TodoWrite: 'todo',
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
};

function parseToolInput(input: string): Record<string, unknown> | null {
  try {
    return typeof input === 'string' ? JSON.parse(input) : input;
  } catch {
    return null;
  }
}

/** Extract a short summary for non-todo tool call milestones */
function getToolCallSummary(name: string, parsed: Record<string, unknown>): string | null {
  if (name === 'AskUserQuestion') {
    const questions = parsed.questions;
    if (!Array.isArray(questions) || questions.length === 0) return null;
    return (questions[0].question as string) ?? 'Question';
  }

  if (name === 'ExitPlanMode') {
    return 'Plan ready for review';
  }

  return null;
}

function todoKey(todo: TodoItem): string {
  return todo.content || todo.activeForm || '';
}

function assistantToolCalls(message: TimelineMessage): ToolCall[] {
  return message.role === 'assistant' && message.toolCalls ? message.toolCalls : [];
}

function readTodoSnapshot(tc: ToolCall, timestamp: string): TodoSnapshot | null {
  if (tc.name !== 'TodoWrite') return null;
  const todos = parseToolInput(tc.input)?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  return { todos, toolCallId: tc.id, timestamp };
}

function collectTodoSnapshots(messages: TimelineMessage[]): TodoSnapshot[] {
  const snapshots: TodoSnapshot[] = [];
  for (const m of messages) {
    for (const tc of assistantToolCalls(m)) {
      const snapshot = readTodoSnapshot(tc, m.timestamp);
      if (snapshot) snapshots.push(snapshot);
    }
  }
  return snapshots;
}

/**
 * Track when each todo (keyed by content) first appeared in any snapshot and
 * its most recent status from the last snapshot that contains it.
 */
function indexTodoHistory(snapshots: TodoSnapshot[]): Pick<TodoIndex, 'firstSeen' | 'latest'> {
  const firstSeen: TodoIndex['firstSeen'] = new Map();
  const latest: TodoIndex['latest'] = new Map();
  snapshots.forEach((snap, snapshotIdx) => {
    for (const todo of snap.todos) {
      const key = todoKey(todo);
      if (!firstSeen.has(key)) {
        firstSeen.set(key, { timestamp: snap.timestamp, toolCallId: snap.toolCallId, snapshotIdx });
      }
      latest.set(key, { status: todo.status, activeForm: todo.activeForm, content: todo.content });
    }
  });
  return { firstSeen, latest };
}

/** Group the latest snapshot's todos by the snapshot where they first appeared, preserving order */
function groupByFirstSnapshot(
  lastSnapshot: TodoSnapshot | undefined,
  firstSeen: TodoIndex['firstSeen'],
): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const todo of lastSnapshot?.todos ?? []) {
    const key = todoKey(todo);
    const seen = firstSeen.get(key);
    if (!seen) continue;
    const group = groups.get(seen.snapshotIdx) ?? [];
    group.push(key);
    groups.set(seen.snapshotIdx, group);
  }
  return groups;
}

function buildTodoIndex(messages: TimelineMessage[]): TodoIndex {
  const snapshots = collectTodoSnapshots(messages);
  const lastSnapshot = snapshots.at(-1);
  const { firstSeen, latest } = indexTodoHistory(snapshots);
  return {
    total: lastSnapshot?.todos.length ?? 0,
    firstSeen,
    latest,
    byFirstSnapshot: groupByFirstSnapshot(lastSnapshot, firstSeen),
    snapshotIndexByToolCallId: new Map(snapshots.map((s, index) => [s.toolCallId, index])),
  };
}

/** In-progress todos of a finished thread are shown as completed. */
function todoProgress(status: string | undefined, finished: boolean) {
  const inProgressStatus = status === 'in_progress';
  return {
    isInProgress: inProgressStatus && !finished,
    isCompleted: status === 'completed' || (inProgressStatus && finished),
  };
}

function todoLabel(todo: TodoItem, isInProgress: boolean, todoIndex: number): string {
  if (isInProgress && todo.activeForm) return todo.activeForm;
  return todo.content || todo.activeForm || `Task ${todoIndex + 1}`;
}

function todoMilestone(
  index: TodoIndex,
  key: string,
  todoIndex: number,
  toolCallId: string,
  finished: boolean,
): MilestoneDraft | null {
  const latest = index.latest.get(key);
  const firstSeen = index.firstSeen.get(key);
  if (!latest || !firstSeen) return null;
  const { isInProgress, isCompleted } = todoProgress(latest.status, finished);
  const label = todoLabel(latest, isInProgress, todoIndex);
  return {
    id: `todo-${toolCallId}-${todoIndex}`,
    content: `${todoIndex + 1}/${index.total} · ${label}`,
    timestamp: firstSeen.timestamp,
    type: 'todo',
    toolCallId: firstSeen.toolCallId,
    completed: isCompleted,
    inProgress: isInProgress,
  };
}

/**
 * Returns a function that, given a TodoWrite tool call id, emits the todos that
 * first appeared in every not-yet-emitted snapshot up to and including that one.
 */
function createTodoEmitter(index: TodoIndex, finished: boolean) {
  let nextSnapshotToEmit = 0;
  let todoIndex = 0;
  return (toolCallId: string): MilestoneDraft[] => {
    const snapIdx = index.snapshotIndexByToolCallId.get(toolCallId) ?? -1;
    if (snapIdx < 0) return [];
    const drafts: MilestoneDraft[] = [];
    for (let si = nextSnapshotToEmit; si <= snapIdx; si++) {
      for (const key of index.byFirstSnapshot.get(si) ?? []) {
        const draft = todoMilestone(index, key, todoIndex, toolCallId, finished);
        if (!draft) continue;
        drafts.push(draft);
        todoIndex++;
      }
    }
    nextSnapshotToEmit = snapIdx + 1;
    return drafts;
  };
}

function toolCallMilestone(tc: ToolCall, timestamp: string): MilestoneDraft | null {
  const type = TOOL_CALL_TYPES[tc.name];
  if (!type) return null;
  const parsed = parseToolInput(tc.input);
  if (!parsed) return null;
  const summary = getToolCallSummary(tc.name, parsed);
  if (!summary) return null;
  return { id: `tc-${tc.id}`, content: summary, timestamp, type, toolCallId: tc.id };
}

function messageMilestones(
  m: TimelineMessage,
  emitTodos: (toolCallId: string) => MilestoneDraft[],
): MilestoneDraft[] {
  const drafts: MilestoneDraft[] = [];
  if (m.role === 'user' && m.content?.trim()) {
    drafts.push({ id: m.id, content: m.content, timestamp: m.timestamp, type: 'prompt' });
  }
  for (const tc of assistantToolCalls(m)) {
    if (tc.name === 'TodoWrite') {
      drafts.push(...emitTodos(tc.id));
      continue;
    }
    const draft = toolCallMilestone(tc, m.timestamp);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

export function buildPromptMilestones(
  messages: TimelineMessage[],
  threadStatus: ThreadStatus | undefined,
): PromptMilestone[] {
  if (messages.length === 0) return [];

  // Only finished threads (completed / failed / stopped) get an end marker
  const endLabel = threadStatus ? END_LABELS[threadStatus] : undefined;
  const finished = endLabel !== undefined;
  const emitTodos = createTodoEmitter(buildTodoIndex(messages), finished);

  const drafts: MilestoneDraft[] = [
    { id: 'timeline-start', content: 'Start', timestamp: messages[0].timestamp, type: 'start' },
  ];
  for (const m of messages) drafts.push(...messageMilestones(m, emitTodos));

  if (endLabel !== undefined) {
    drafts.push({
      id: 'timeline-end',
      content: endLabel,
      timestamp: messages[messages.length - 1].timestamp,
      type: 'end',
    });
  }

  return drafts.map((draft, index) => ({ ...draft, index }));
}
