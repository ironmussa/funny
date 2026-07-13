/**
 * Long-thread fixture — a deterministic, reusable generator of a large thread
 * with mixed markdown + tool calls. Shared by unit tests, the markdown
 * benchmark harness, and the client profiler so every measurement runs against
 * the same content.
 *
 * Determinism: a seeded PRNG (mulberry32) drives all "random" choices, so the
 * same `seed` + `messageCount` always yields byte-identical output. Heights are
 * intentionally varied (one-liners next to code-heavy / table-heavy answers) to
 * stress height estimation and measurement in the virtualizer.
 *
 * This lives under `src/` (not `__tests__/`) so it is importable from Vite
 * browser bundles (benchmark playground, profiling fixture) as well as Node
 * tests. It has no runtime imports beyond shared types, so bundling it costs
 * nothing unless a module actually imports it.
 */
import type { Message, ToolCall } from '@funny/shared';

export interface LongThreadOptions {
  /** Total number of messages (user + assistant). Default 500. */
  messageCount?: number;
  /** Seed for the deterministic PRNG. Default 1. */
  seed?: number;
  /** Thread id stamped onto every message/tool call. Default 'fixture-thread'. */
  threadId?: string;
  /** Fraction (0–1) of assistant messages that carry tool calls. Default 0.5. */
  toolCallRatio?: number;
}

export interface LongThreadFixture {
  threadId: string;
  /** Messages with interleaved tool calls, oldest first. */
  messages: (Message & { toolCalls: ToolCall[] })[];
  /** Just the raw assistant-markdown strings, for renderer benchmarks. */
  markdownCorpus: string[];
  /** Convenience totals. */
  counts: { messages: number; toolCalls: number; assistant: number; user: number };
}

/** mulberry32 — tiny deterministic PRNG. Returns a float in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

const LOREM =
  'The runner spawns the agent process and streams tool calls back over the ' +
  'WebSocket data channel while the server persists each message. ';

/** A short, single-line assistant answer. */
function shortMarkdown(index: number, rand: () => number): string {
  const openers = [
    'Done — the change is in place.',
    'That failed because the worktree was dirty.',
    'Looks good; the tests pass.',
    'I updated the handler and re-ran the suite.',
  ];
  return `${pick(rand, openers)} (step ${index})`;
}

/** A code-heavy answer with a fenced block and a raw-HTML sanitizer probe. */
function codeMarkdown(index: number, rand: () => number): string {
  const lang = pick(rand, ['ts', 'tsx', 'bash', 'json']);
  return [
    `### Patch ${index}`,
    '',
    'Here is the change with **bold**, `inline code`, and a raw-HTML probe the',
    'sanitizer must neutralize: <img src=x onerror="alert(1)">.',
    '',
    '```' + lang,
    'export function summarize(messages: ThreadMessage[]) {',
    '  return messages',
    '    .filter((m) => m.content.trim().length > 0)',
    '    .map((m) => m.content.trim())',
    "    .join('\\n\\n');",
    '}',
    '```',
    '',
    `Open [MessageContent.tsx](/home/u/funny/packages/client/src/components/thread/MessageContent.tsx:${80 + index})`,
    `and compare [the PR](https://github.com/acme/repo/pull/${index}).`,
  ].join('\n');
}

/** A table + task-list answer (GFM stress). */
function tableMarkdown(index: number, _rand: () => number): string {
  return [
    `## Comparison ${index}`,
    '',
    '| Area | Current | Candidate |',
    '| --- | ---: | ---: |',
    `| Parse | react-markdown | satteri |`,
    '| Render | React components | HTML string |',
    '| Memory | per-node fibers | one subtree |',
    '',
    '- [x] Preserve sanitized rendering',
    '- [ ] Keep task-list checkboxes readable',
    '- [ ] Avoid breaking file links',
  ].join('\n');
}

/** A long multi-paragraph prose answer. */
function proseMarkdown(index: number, rand: () => number): string {
  const paragraphs = 2 + Math.floor(rand() * 3);
  const blocks: string[] = [`## Analysis ${index}`, ''];
  for (let p = 0; p < paragraphs; p++) {
    blocks.push(LOREM.repeat(2 + Math.floor(rand() * 3)).trim());
    blocks.push('');
  }
  blocks.push('> Note: this path is engine-agnostic — freezing works with any HTML source.');
  return blocks.join('\n');
}

const MARKDOWN_KINDS = [shortMarkdown, codeMarkdown, tableMarkdown, proseMarkdown] as const;

function makeAssistantMarkdown(index: number, rand: () => number): string {
  return pick(rand, MARKDOWN_KINDS)(index, rand);
}

function makeUserMarkdown(index: number, rand: () => number): string {
  const prompts = [
    'Can you fix the scroll jump when new messages stream in?',
    'Why is the thread using so much memory on long conversations?',
    'Add a regression test for the diff read failure.',
    'Refactor this to return a Result instead of throwing.',
    'Search the codebase for where the virtualizer measures row heights.',
  ];
  return `${pick(rand, prompts)} (turn ${index})`;
}

function makeToolCall(
  seqId: number,
  messageId: string,
  timestamp: string,
  rand: () => number,
): ToolCall {
  const kind = pick(rand, ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'TodoWrite'] as const);
  const id = `tc-${seqId}`;
  switch (kind) {
    case 'Bash': {
      const lines = 5 + Math.floor(rand() * 40);
      const output = Array.from({ length: lines }, (_, i) => `line ${i + 1}: build output`).join(
        '\n',
      );
      return {
        id,
        messageId,
        name: 'Bash',
        input: JSON.stringify({ command: 'bun run build', description: 'Build all packages' }),
        output,
        timestamp,
      };
    }
    case 'Read':
      return {
        id,
        messageId,
        name: 'Read',
        input: JSON.stringify({ file_path: `/project/src/module-${seqId}.ts` }),
        output: Array.from({ length: 20 }, (_, i) => `${i + 1}\tconst x${i} = ${i};`).join('\n'),
        timestamp,
      };
    case 'Write':
      return {
        id,
        messageId,
        name: 'Write',
        input: JSON.stringify({
          file_path: `/project/src/new-${seqId}.ts`,
          content: `export const value${seqId} = ${seqId};\n`,
        }),
        timestamp,
      };
    case 'Edit':
      return {
        id,
        messageId,
        name: 'Edit',
        input: JSON.stringify({
          file_path: `/project/src/edit-${seqId}.ts`,
          old_string: `const a = ${seqId};`,
          new_string: `const a = ${seqId + 1};`,
        }),
        timestamp,
      };
    case 'Grep':
      return {
        id,
        messageId,
        name: 'Grep',
        input: JSON.stringify({ pattern: 'measureRowHeight', output_mode: 'files_with_matches' }),
        output: 'packages/client/src/components/thread/MemoizedMessageList.tsx',
        timestamp,
      };
    case 'TodoWrite':
      return {
        id,
        messageId,
        name: 'TodoWrite',
        input: JSON.stringify({
          todos: [
            { content: 'Build the fixture', status: 'completed' },
            { content: 'Benchmark WASM', status: 'in_progress' },
            { content: 'Evaluate the gate', status: 'pending' },
          ],
        }),
        timestamp,
      };
  }
}

/**
 * Build a deterministic long thread. Messages alternate user → assistant, with
 * a configurable share of assistant messages carrying 1–3 tool calls.
 */
export function makeLongThread(options: LongThreadOptions = {}): LongThreadFixture {
  const messageCount = options.messageCount ?? 500;
  const threadId = options.threadId ?? 'fixture-thread';
  const toolCallRatio = options.toolCallRatio ?? 0.5;
  const rand = mulberry32(options.seed ?? 1);

  const baseTime = Date.parse('2024-01-01T00:00:00Z');
  const messages: (Message & { toolCalls: ToolCall[] })[] = [];
  const markdownCorpus: string[] = [];
  let toolSeq = 0;
  let assistantCount = 0;
  let userCount = 0;

  for (let i = 0; i < messageCount; i++) {
    const isUser = i % 2 === 0;
    const id = `msg-${i}`;
    // 1-second cadence keeps timestamps strictly increasing and parseable.
    const timestamp = new Date(baseTime + i * 1000).toISOString();
    const content = isUser ? makeUserMarkdown(i, rand) : makeAssistantMarkdown(i, rand);
    if (!isUser) markdownCorpus.push(content);

    const toolCalls: ToolCall[] = [];
    if (!isUser && rand() < toolCallRatio) {
      const count = 1 + Math.floor(rand() * 3);
      for (let c = 0; c < count; c++) {
        const tcTimestamp = new Date(baseTime + i * 1000 + (c + 1) * 100).toISOString();
        toolCalls.push(makeToolCall(toolSeq++, id, tcTimestamp, rand));
      }
    }

    if (isUser) userCount++;
    else assistantCount++;

    messages.push({
      id,
      threadId,
      role: isUser ? 'user' : 'assistant',
      content,
      timestamp,
      toolCalls,
    });
  }

  return {
    threadId,
    messages,
    markdownCorpus,
    counts: {
      messages: messages.length,
      toolCalls: toolSeq,
      assistant: assistantCount,
      user: userCount,
    },
  };
}
