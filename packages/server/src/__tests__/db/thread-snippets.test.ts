/**
 * The thread list shows each thread's last non-empty assistant message.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

let raw: import('bun:sqlite').Database;
let listThreads: (opts: { userId: string; limit?: number }) => Promise<{ threads: any[] }>;

beforeAll(async () => {
  const { initDatabase, db } = await import('../../db/index.js');
  await initDatabase({ sqlitePath: ':memory:' });
  const { autoMigrate } = await import('../../db/migrate.js');
  await autoMigrate();
  raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
  const { repos } = await import('../../db/repos.js');
  listThreads = (opts) => repos.threads().listThreads(opts);
});

function thread(id: string) {
  raw.run(`INSERT INTO threads (id, user_id, title, created_at) VALUES (?, 'u-snip', ?, ?)`, [
    id,
    id,
    '2026-01-01T00:00:00.000Z',
  ]);
}

let seq = 0;
function message(threadId: string, role: string, content: string) {
  const ts = `2026-01-01T00:00:${String(++seq).padStart(2, '0')}.000Z`;
  raw.run(`INSERT INTO messages (id, thread_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`, [
    `m-${seq}`,
    threadId,
    role,
    content,
    ts,
  ]);
}

describe('listThreads lastAssistantMessage', () => {
  test('is the newest non-empty assistant message, truncated, per thread', async () => {
    thread('t-a');
    message('t-a', 'user', 'question');
    message('t-a', 'assistant', 'old answer');
    message('t-a', 'assistant', 'x'.repeat(300));
    message('t-a', 'assistant', ''); // tool-call placeholder
    message('t-a', 'user', 'follow-up');

    thread('t-b');
    message('t-b', 'user', 'only a question');

    thread('t-c');
    message('t-c', 'assistant', 'answer c');

    const { threads } = await listThreads({ userId: 'u-snip' });
    const byId = Object.fromEntries(threads.map((t) => [t.id, t.lastAssistantMessage]));
    expect(byId['t-a']).toBe('x'.repeat(120));
    expect(byId['t-b']).toBeUndefined();
    expect(byId['t-c']).toBe('answer c');
  });
});
