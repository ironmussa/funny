import type { Page } from '@playwright/test';

/* ------------------------------------------------------------------ */
/*  Mock data factories                                                */
/* ------------------------------------------------------------------ */

let _idCounter = 0;
function mockId() {
  return `mock-${Date.now()}-${++_idCounter}`;
}

export function mockMessage(
  overrides: Partial<{
    id: string;
    threadId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    model: string;
    author: string;
    toolCalls: MockToolCall[];
  }> = {},
) {
  return {
    id: overrides.id ?? mockId(),
    threadId: overrides.threadId ?? 'mock-thread',
    role: overrides.role ?? 'assistant',
    content: overrides.content ?? 'Hello from the assistant.',
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    model: overrides.model ?? 'sonnet-4',
    author: overrides.author,
    toolCalls: overrides.toolCalls ?? [],
  };
}

export interface MockToolCall {
  id: string;
  messageId: string;
  name: string;
  input: string;
  output?: string;
  author?: string;
}

export function mockToolCall(overrides: Partial<MockToolCall> = {}): MockToolCall {
  const id = overrides.id ?? mockId();
  return {
    id,
    messageId: overrides.messageId ?? mockId(),
    name: overrides.name ?? 'Read',
    input: overrides.input ?? JSON.stringify({ file_path: '/src/index.ts' }),
    output: overrides.output ?? 'file contents here...',
    author: overrides.author,
  };
}

export function mockBashToolCall(command = 'ls -la', output = 'total 42\ndrwxr-xr-x ...') {
  return mockToolCall({
    name: 'Bash',
    input: JSON.stringify({ command }),
    output,
  });
}

export function mockEditToolCall(path = '/src/app.ts', oldStr = 'foo', newStr = 'bar') {
  return mockToolCall({
    name: 'Edit',
    input: JSON.stringify({ file_path: path, old_string: oldStr, new_string: newStr }),
    output: 'File edited successfully.',
  });
}

export function mockWriteToolCall(path = '/src/new-file.ts', content = 'export const x = 1;') {
  return mockToolCall({
    name: 'Write',
    input: JSON.stringify({ file_path: path, content }),
    output: 'File written successfully.',
  });
}

export function mockReadToolCall(path = '/src/index.ts', content = 'const app = express();') {
  return mockToolCall({
    name: 'Read',
    input: JSON.stringify({ file_path: path }),
    output: content,
  });
}

export function mockThreadEvent(
  overrides: Partial<{
    id: string;
    threadId: string;
    type: string;
    data: string;
    createdAt: string;
  }> = {},
) {
  return {
    id: overrides.id ?? mockId(),
    threadId: overrides.threadId ?? 'mock-thread',
    type: overrides.type ?? 'git:commit',
    data: overrides.data ?? JSON.stringify({ message: 'feat: add feature', sha: 'abc1234' }),
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  Full thread response builders                                      */
/* ------------------------------------------------------------------ */

export function mockThreadWithMessages(
  threadId: string,
  projectId: string,
  overrides: Partial<{
    status: string;
    title: string;
    messages: ReturnType<typeof mockMessage>[];
    threadEvents: ReturnType<typeof mockThreadEvent>[];
    resultInfo: { status: string; cost: number; duration: number; error?: string } | null;
    waitingReason: string | null;
    pendingPermission: { toolName: string } | null;
    initInfo: { tools: string[]; cwd: string; model: string } | null;
    contextUsage: {
      cumulativeInputTokens: number;
      lastInputTokens: number;
      lastOutputTokens: number;
    } | null;
  }> = {},
) {
  return {
    id: threadId,
    projectId,
    userId: 'test-user',
    title: overrides.title ?? 'Mock Thread',
    mode: 'local',
    status: overrides.status ?? 'completed',
    stage: 'in_progress',
    provider: 'claude',
    permissionMode: 'autoEdit',
    model: 'sonnet-4',
    cost: 0.05,
    source: 'web',
    createdAt: new Date().toISOString(),
    messages: overrides.messages ?? [],
    threadEvents: overrides.threadEvents ?? [],
    hasMore: false,
    initInfo: overrides.initInfo ?? {
      tools: ['Read', 'Write', 'Edit', 'Bash'],
      cwd: '/project',
      model: 'sonnet-4',
    },
    resultInfo: overrides.resultInfo ?? null,
    waitingReason: overrides.waitingReason ?? undefined,
    pendingPermission: overrides.pendingPermission ?? undefined,
    contextUsage: overrides.contextUsage ?? undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  Conversation presets                                                */
/* ------------------------------------------------------------------ */

/** A thread with a user prompt and a markdown assistant reply */
export function conversationWithMarkdown(threadId: string, projectId: string) {
  return mockThreadWithMessages(threadId, projectId, {
    status: 'completed',
    messages: [
      mockMessage({ threadId, role: 'user', content: 'Explain how promises work in JavaScript' }),
      mockMessage({
        threadId,
        role: 'assistant',
        content: [
          '# Promises in JavaScript',
          '',
          'A **Promise** represents a value that may be available now, later, or never.',
          '',
          '## States',
          '',
          '- `pending` — initial state',
          '- `fulfilled` — operation completed successfully',
          '- `rejected` — operation failed',
          '',
          '## Example',
          '',
          '```javascript',
          'const promise = new Promise((resolve, reject) => {',
          '  setTimeout(() => resolve("done"), 1000);',
          '});',
          '',
          'promise.then(value => console.log(value));',
          '```',
          '',
          '> Promises are the foundation of modern async JavaScript.',
        ].join('\n'),
      }),
    ],
    resultInfo: { status: 'completed', cost: 0.02, duration: 5000 },
  });
}

/** A thread with tool calls (Read, Edit, Bash) */
export function conversationWithToolCalls(threadId: string, projectId: string) {
  const readTc = mockReadToolCall();
  const editTc = mockEditToolCall();
  const bashTc = mockBashToolCall('npm test', 'PASS all tests');

  const assistantMsg = mockMessage({
    threadId,
    role: 'assistant',
    content: 'Let me read the file, make changes, and run tests.',
    toolCalls: [readTc, editTc, bashTc],
  });
  // Link messageId
  readTc.messageId = assistantMsg.id;
  editTc.messageId = assistantMsg.id;
  bashTc.messageId = assistantMsg.id;

  return mockThreadWithMessages(threadId, projectId, {
    status: 'completed',
    messages: [
      mockMessage({ threadId, role: 'user', content: 'Fix the bug in app.ts' }),
      assistantMsg,
    ],
    resultInfo: { status: 'completed', cost: 0.03, duration: 12000 },
  });
}

/** A thread with git events */
export function conversationWithGitEvents(threadId: string, projectId: string) {
  return mockThreadWithMessages(threadId, projectId, {
    status: 'completed',
    messages: [
      mockMessage({ threadId, role: 'user', content: 'Commit and push the changes' }),
      mockMessage({ threadId, role: 'assistant', content: "I'll commit and push now." }),
    ],
    threadEvents: [
      mockThreadEvent({
        threadId,
        type: 'git:commit',
        data: JSON.stringify({ message: 'feat: add new feature', sha: 'abc1234' }),
      }),
      mockThreadEvent({
        threadId,
        type: 'git:push',
        data: JSON.stringify({ branch: 'feature/new', remote: 'origin' }),
      }),
    ],
    resultInfo: { status: 'completed', cost: 0.01, duration: 3000 },
  });
}

/** A thread in "waiting" state (permission request) */
export function conversationWaitingPermission(threadId: string, projectId: string) {
  return mockThreadWithMessages(threadId, projectId, {
    status: 'waiting',
    waitingReason: 'permission',
    pendingPermission: { toolName: 'Bash' },
    messages: [
      mockMessage({ threadId, role: 'user', content: 'Run the deploy script' }),
      mockMessage({
        threadId,
        role: 'assistant',
        content: 'I need permission to run a bash command.',
      }),
    ],
  });
}

/** A thread in "waiting" state (question) */
export function conversationWaitingQuestion(threadId: string, projectId: string) {
  return mockThreadWithMessages(threadId, projectId, {
    status: 'waiting',
    waitingReason: undefined, // general waiting
    messages: [
      mockMessage({ threadId, role: 'user', content: 'Refactor the auth module' }),
      mockMessage({
        threadId,
        role: 'assistant',
        content: 'Which auth strategy do you prefer? JWT or session-based?',
      }),
    ],
  });
}

/** A thread that was stopped */
export function conversationStopped(threadId: string, projectId: string) {
  return mockThreadWithMessages(threadId, projectId, {
    status: 'stopped',
    messages: [
      mockMessage({ threadId, role: 'user', content: 'Implement the whole feature' }),
      mockMessage({ threadId, role: 'assistant', content: 'Starting the implementation...' }),
    ],
  });
}

/** A thread that was interrupted */
export function conversationInterrupted(threadId: string, projectId: string) {
  return mockThreadWithMessages(threadId, projectId, {
    status: 'interrupted',
    messages: [
      mockMessage({ threadId, role: 'user', content: 'Do a complex refactor' }),
      mockMessage({ threadId, role: 'assistant', content: 'Working on it...' }),
    ],
  });
}

/** A thread with context usage */
export function conversationWithContextUsage(threadId: string, projectId: string) {
  return mockThreadWithMessages(threadId, projectId, {
    status: 'completed',
    contextUsage: { cumulativeInputTokens: 45000, lastInputTokens: 12000, lastOutputTokens: 3000 },
    messages: [
      mockMessage({ threadId, role: 'user', content: 'Analyze the codebase' }),
      mockMessage({
        threadId,
        role: 'assistant',
        content: 'Here is my analysis of the codebase...',
      }),
    ],
    resultInfo: { status: 'completed', cost: 0.08, duration: 20000 },
  });
}

/* ------------------------------------------------------------------ */
/*  WebSocket event injection                                          */
/* ------------------------------------------------------------------ */

/**
 * Inject a WebSocket event into the page's WS connection.
 * This dispatches a MessageEvent on the existing WebSocket,
 * simulating a server-sent event.
 */
export async function injectWSEvent(
  page: Page,
  event: {
    type: string;
    threadId: string;
    data: Record<string, unknown>;
  },
) {
  await page.evaluate((evt) => {
    // Find the active WebSocket instance
    const allWs = (window as any).__playwright_ws_instances;
    if (allWs && allWs.length > 0) {
      const ws = allWs[allWs.length - 1];
      const msgEvent = new MessageEvent('message', {
        data: JSON.stringify(evt),
      });
      ws.dispatchEvent(msgEvent);
    }
  }, event);
}

/**
 * Hook into WebSocket creation to capture instances for later injection.
 * Call this BEFORE navigating to the page.
 */
export async function setupWSIntercept(page: Page) {
  await page.addInitScript(() => {
    (window as any).__playwright_ws_instances = [];
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as any).__playwright_ws_instances.push(this);
      }
    } as any;
  });
}

/* ------------------------------------------------------------------ */
/*  API route mocking helpers                                          */
/* ------------------------------------------------------------------ */

/** Mock the GET /api/threads/:id response with custom data */
export async function mockThreadResponse(
  page: Page,
  threadId: string,
  data: ReturnType<typeof mockThreadWithMessages>,
) {
  await page.route(`**/api/threads/${threadId}**`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });
    } else {
      await route.continue();
    }
  });
}

/** Mock the analytics overview response */
export function mockAnalyticsOverview(
  overrides: Partial<{
    currentStageDistribution: Record<string, number>;
    createdCount: number;
    completedCount: number;
    movedToPlanningCount: number;
    movedToReviewCount: number;
    movedToDoneCount: number;
    movedToArchivedCount: number;
    totalCost: number;
  }> = {},
) {
  return {
    currentStageDistribution: overrides.currentStageDistribution ?? {
      backlog: 5,
      planning: 3,
      in_progress: 8,
      review: 2,
      done: 12,
    },
    createdCount: overrides.createdCount ?? 30,
    completedCount: overrides.completedCount ?? 22,
    movedToPlanningCount: overrides.movedToPlanningCount ?? 15,
    movedToReviewCount: overrides.movedToReviewCount ?? 10,
    movedToDoneCount: overrides.movedToDoneCount ?? 12,
    movedToArchivedCount: overrides.movedToArchivedCount ?? 3,
    totalCost: overrides.totalCost ?? 1.2345,
    timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-02-28T23:59:59Z' },
  };
}

/** Mock the analytics timeline response */
export function mockAnalyticsTimeline() {
  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return d.toISOString().split('T')[0];
  });

  const makeSeries = (counts: number[]) =>
    dates.map((date, i) => ({ date, count: counts[i] ?? 0 }));

  return {
    createdByDate: makeSeries([3, 5, 2, 4, 6, 3, 7]),
    completedByDate: makeSeries([2, 3, 1, 3, 5, 2, 6]),
    movedToPlanningByDate: makeSeries([1, 2, 1, 2, 3, 1, 4]),
    movedToReviewByDate: makeSeries([1, 1, 0, 2, 2, 1, 3]),
    movedToDoneByDate: makeSeries([1, 2, 1, 1, 3, 2, 2]),
    movedToArchivedByDate: makeSeries([0, 0, 1, 0, 1, 0, 1]),
    timeRange: { start: dates[0], end: dates[dates.length - 1] },
  };
}
