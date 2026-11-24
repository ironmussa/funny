/**
 * The recap transcript (openspec thread-recap, D2): built from stored rows,
 * the same for every provider, limited to activity after `since` and to a
 * fixed size with the newest entries kept.
 */
import { describe, expect, test } from 'bun:test';

import type { RecapMessage, RecapTranscriptInput } from '../../services/recap-transcript.js';

// Loaded at test time, so a missing module fails an assertion, not the file load.
const transcriptModule = await import('../../services/recap-transcript.js').catch(() => undefined);
const RECAP_TRANSCRIPT_MAX_CHARS = 12_000;

function loaded() {
  expect(transcriptModule?.buildRecapTranscript).toBeFunction();
  return transcriptModule!;
}

function buildRecapTranscript(input: RecapTranscriptInput, opts?: { maxChars?: number }) {
  return loaded().buildRecapTranscript(input, opts);
}

function summarizeToolInput(raw: string | null | undefined) {
  return loaded().summarizeToolInput(raw);
}

const SINCE = '2026-11-23T10:00:00.000Z';
const before = (s: number) => new Date(Date.parse(SINCE) - s * 1000).toISOString();
const after = (s: number) => new Date(Date.parse(SINCE) + s * 1000).toISOString();

/** A Claude thread: Agent SDK tool names and inputs, a permission request pending. */
const claudeThread: RecapMessage[] = [
  { id: 'c0', role: 'user', content: 'Old request already read', timestamp: before(60) },
  { id: 'c1', role: 'user', content: 'Fix the failing login test', timestamp: after(1) },
  {
    id: 'c2',
    role: 'assistant',
    content: 'I will look at the test first.',
    timestamp: after(2),
    toolCalls: [
      {
        name: 'Read',
        input: JSON.stringify({ file_path: '/repo/src/login.test.ts' }),
        output: 'x'.repeat(5_000),
      },
      {
        name: 'Bash',
        input: JSON.stringify({ command: 'bun test login', description: 'Run the test' }),
        output: null,
      },
    ],
  },
];

/** A Codex thread: tool pairs emitted by codex-sdk (`Bash`, `Edit`, `Think`). */
const codexThread: RecapMessage[] = [
  {
    id: 'x1',
    role: 'assistant',
    content: '',
    timestamp: after(5),
    toolCalls: [
      { name: 'Think', input: JSON.stringify({ content: 'Plan the change' }), output: 'Plan' },
      {
        name: 'Bash',
        input: JSON.stringify({ command: 'rg -n "TODO" src' }),
        output: 'src/a.ts:1: TODO',
      },
      {
        name: 'Edit',
        input: JSON.stringify({ changes: [{ path: 'src/a.ts', kind: 'update' }] }),
        output: 'completed',
      },
    ],
  },
  { id: 'x2', role: 'assistant', content: 'Removed the TODO in src/a.ts.', timestamp: after(6) },
];

/** An LLM API thread: deepagents-style snake_case tools, a question pending. */
const llmApiThread: RecapMessage[] = [
  {
    id: 'l1',
    role: 'assistant',
    content: 'Reading the config.',
    timestamp: after(10),
    toolCalls: [{ name: 'read_file', input: '{"path":"config.json"}', output: '{"a":1}' }],
  },
  {
    id: 'l2',
    role: 'assistant',
    content: '',
    timestamp: after(11),
    toolCalls: [
      {
        name: 'AskUserQuestion',
        input: JSON.stringify({ questions: [{ question: 'Which environment should I use?' }] }),
        output: null,
      },
    ],
  },
];

describe('buildRecapTranscript', () => {
  test('Claude thread: entries after since, tool summaries, 300-char excerpts, pending approval', () => {
    const { text, entryCount } = buildRecapTranscript({
      since: SINCE,
      status: 'waiting',
      waitingReason: 'permission',
      pendingPermission: {
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: 'bun test login' }),
      },
      messages: claudeThread,
    });
    expect(text).not.toContain('Old request already read');
    expect(text).toContain('User: Fix the failing login test');
    expect(text).toContain('Agent: I will look at the test first.');
    expect(text).toContain('Tool Read: /repo/src/login.test.ts');
    expect(text).toContain('Tool Bash: bun test login\n  → (no output yet)');
    // The 5000-char output is cut to a 300-char excerpt.
    expect(text).not.toContain('x'.repeat(301));
    expect(text).toContain('x'.repeat(299));
    expect(text).toContain('Thread status: waiting.');
    expect(text).toContain('Waiting on the user: approval to run Bash (bun test login).');
    expect(entryCount).toBe(4);
  });

  test('Codex thread: the same shape from codex tool pairs', () => {
    const { text, entryCount } = buildRecapTranscript({
      since: SINCE,
      status: 'completed',
      messages: codexThread,
    });
    expect(text).toContain('Tool Think: Plan the change');
    expect(text).toContain('Tool Bash: rg -n "TODO" src\n  → src/a.ts:1: TODO');
    expect(text).toContain('Tool Edit: {"changes":[{"path":"src/a.ts","kind":"update"}]}');
    expect(text).toContain('Agent: Removed the TODO in src/a.ts.');
    expect(text).toContain('Thread status: completed.');
    expect(text).not.toContain('Waiting on the user');
    expect(entryCount).toBe(4);
  });

  test('LLM API thread: a pending question is named in the state', () => {
    const { text } = buildRecapTranscript({
      since: SINCE,
      status: 'waiting',
      waitingReason: 'question',
      messages: llmApiThread,
    });
    expect(text).toContain('Tool read_file: config.json\n  → {"a":1}');
    expect(text).toContain('Tool AskUserQuestion: Which environment should I use?');
    expect(text).toContain(
      'Waiting on the user: an answer to the question "Which environment should I use?".',
    );
  });

  test('nothing after since: empty transcript', () => {
    const result = buildRecapTranscript({
      since: after(3_600),
      status: 'completed',
      messages: claudeThread,
    });
    expect(result).toEqual({ text: '', entryCount: 0, omittedCount: 0 });
  });

  test('thousands of new messages: the newest are kept within the limit', () => {
    const messages: RecapMessage[] = Array.from({ length: 5_000 }, (_, i) => ({
      id: `m${i}`,
      role: 'assistant',
      content: `Step ${i} done`,
      timestamp: after(i + 1),
      toolCalls: [{ name: 'Bash', input: '{"command":"make"}', output: 'ok '.repeat(200) }],
    }));
    const { text, entryCount, omittedCount } = buildRecapTranscript({
      since: SINCE,
      status: 'running',
      messages,
    });
    expect(text.length).toBeLessThanOrEqual(RECAP_TRANSCRIPT_MAX_CHARS);
    expect(entryCount).toBe(10_000);
    expect(omittedCount).toBeGreaterThan(0);
    expect(text).toContain('Step 4999 done');
    expect(text).not.toContain('Step 0 done');
    expect(text).toContain(`[${omittedCount} earlier entries omitted]`);
    expect(text).toContain('Thread status: running.');
  });

  test('a huge single message cannot crowd out the state line', () => {
    const { text } = buildRecapTranscript({
      since: SINCE,
      status: 'failed',
      messages: [{ id: 'h', role: 'assistant', content: 'y'.repeat(50_000), timestamp: after(1) }],
    });
    expect(text.length).toBeLessThanOrEqual(RECAP_TRANSCRIPT_MAX_CHARS);
    expect(text).toContain('Thread status: failed.');
  });
});

describe('summarizeToolInput', () => {
  test('one line, clipped, from a telling field', () => {
    const summary = summarizeToolInput(JSON.stringify({ command: `echo a\n${'b'.repeat(400)}` }));
    expect(summary).not.toContain('\n');
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary.startsWith('echo a b')).toBe(true);
  });

  test('raw text input stays as text', () => {
    expect(summarizeToolInput('not json')).toBe('not json');
    expect(summarizeToolInput(null)).toBe('');
  });
});
