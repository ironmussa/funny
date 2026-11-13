/**
 * search-repository: the case-insensitive search must narrow rows in SQL
 * (issue #191) instead of loading every message of the user, while keeping
 * accent-insensitive matching (`nina` → `niña`).
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { normalizeSearchText } from '@funny/shared/lib/text-search';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedMessage, seedProject, seedThread } from '../helpers/test-db.js';

let t: TestApp;
let repo: typeof import('../../services/search-repository.js');

beforeAll(async () => {
  t = await createTestApp();
  repo = await import('../../services/search-repository.js');
});

function seed(contents: Record<string, string>) {
  seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
  let n = 0;
  for (const [threadId, content] of Object.entries(contents)) {
    seedThread(t.db as any, { id: threadId, projectId: 'p1', userId: 'user-1' });
    seedMessage(t.db as any, {
      id: `m-${threadId}`,
      threadId,
      content,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString(),
    });
  }
}

/** Message ids the SQL prefilter lets through (what gets loaded into JS). */
function prefiltered(query: string): string[] {
  const { schema, db } = t;
  return (db as any)
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(repo.contentPrefilter(query))
    .all()
    .map((r: { id: string }) => r.id)
    .sort();
}

beforeEach(() => t.cleanup());

describe('contentPrefilter (case-insensitive)', () => {
  test('excludes messages that cannot match an ASCII query', () => {
    seed({
      hit: 'The LOGIN form is broken',
      miss: 'nothing related here',
      arrows: 'unicode → but no match…',
    });
    expect(prefiltered('login')).toEqual(['m-hit']);
  });

  test('keeps messages whose accents or combining marks fold onto the query', () => {
    seed({
      nfc: 'La niña tomó café',
      nfd: 'La niña',
      keycap: 'press 1️⃣ now',
      miss: 'plain text',
    });
    expect(prefiltered('nina')).toEqual(['m-keycap', 'm-nfc', 'm-nfd']);
  });

  test('keeps a message for every character that folds onto ASCII or is erased', () => {
    // Exhaustive: any such character inside an ASCII word must not hide the
    // word from SQL, since the JS check (normalizeSearchText) ignores it.
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
    const ids: string[] = [];
    const rows: (typeof t.schema.messages.$inferInsert)[] = [];
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      const folded = normalizeSearchText(ch);
      if (folded !== '' && !Array.from(folded).some((c) => c.charCodeAt(0) < 0x80)) continue;
      const content = `q${ch}z`;
      if (!normalizeSearchText(content).includes('qz')) continue;
      const id = `cp-${cp.toString(16)}`;
      ids.push(id);
      rows.push({ id, threadId: 't1', role: 'user', content, timestamp: '2026-01-01T00:00:00Z' });
    }
    for (let i = 0; i < rows.length; i += 500) {
      (t.db as any)
        .insert(t.schema.messages)
        .values(rows.slice(i, i + 500))
        .run();
    }
    expect(ids.length).toBeGreaterThan(2000);
    expect(prefiltered('qz')).toEqual(ids.sort());
  });

  test('keeps `≠` for a query with `=`', () => {
    seed({ ne: 'if a≠b then', miss: 'if a<b then' });
    expect(prefiltered('a=b')).toEqual(['m-ne']);
  });

  test('a non-ASCII query only loads messages with non-ASCII text', () => {
    seed({ ru: 'Привет мир', ascii: 'hello world' });
    expect(prefiltered('привет')).toEqual(['m-ru']);
  });

  test('escapes LIKE wildcards in the query', () => {
    seed({ literal: 'set 100% now', other: 'set 1000 now' });
    expect(prefiltered('100%')).toEqual(['m-literal']);
  });
});

describe('search results', () => {
  test('searchThreadIdsByContent still matches accent-insensitively', async () => {
    seed({ t1: 'La niña tomó café', t2: 'nothing' });
    const res = await repo.searchThreadIdsByContent({ query: 'cafe', userId: 'user-1' });
    expect([...res.keys()]).toEqual(['t1']);
  });

  test('searchThreadMessages pages past the first batch without repeats', async () => {
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `m${String(i).padStart(4, '0')}`,
      threadId: 't1',
      role: 'user',
      // Every message passes the SQL prefilter (accented), only every 3rd matches.
      content: i % 3 === 0 ? 'café hit' : 'café',
      // Shared timestamps force the id tie-break across page boundaries.
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 7))).toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      (t.db as any)
        .insert(t.schema.messages)
        .values(rows.slice(i, i + 500))
        .run();
    }
    const res = await repo.searchThreadMessages({
      userId: 'user-1',
      query: 'cafe hit',
      limit: 500,
    });
    const expected = rows
      .filter((_, i) => i % 3 === 0)
      .map((r) => r.id)
      .reverse();
    expect(res.map((r) => r.messageId)).toEqual(expected);
  });

  test('searchThreadMessages honours the limit, most recent first', async () => {
    seed({ a: 'match one', b: 'no', c: 'Match two', d: 'MATCH three' });
    const res = await repo.searchThreadMessages({ userId: 'user-1', query: 'match', limit: 2 });
    expect(res.map((r) => r.messageId)).toEqual(['m-d', 'm-c']);
  });
});
