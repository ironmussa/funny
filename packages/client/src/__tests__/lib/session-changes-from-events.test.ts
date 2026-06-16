import type { ThreadEvent } from '@funny/shared';
import { describe, test, expect } from 'vitest';

import { sessionChangesFromEvents } from '@/lib/session-changes-from-events';

function summaryEvent(id: string, userMessageId: string, files: any[]): ThreadEvent {
  return {
    id,
    threadId: 't1',
    type: 'changed_files_summary',
    data: JSON.stringify({ userMessageId, files }),
    createdAt: '2026-06-15T00:00:00.000Z',
  };
}

const FILE = { path: 'src/a.ts', status: 'modified', staged: false, additions: 22, deletions: 6 };

describe('sessionChangesFromEvents', () => {
  test('builds a per-session map keyed by userMessageId from persisted events', () => {
    const map = sessionChangesFromEvents([
      summaryEvent('e1', 'u1', [FILE]),
      summaryEvent('e2', 'u2', [{ ...FILE, path: 'src/b.ts' }]),
    ]);
    expect([...map.keys()]).toEqual(['u1', 'u2']);
    expect(map.get('u1')).toEqual([FILE]);
    expect(map.get('u2')![0].path).toBe('src/b.ts');
  });

  test('the frozen +/- stats come straight from the event, not recomputed', () => {
    const map = sessionChangesFromEvents([summaryEvent('e1', 'u1', [FILE])]);
    expect(map.get('u1')![0]).toMatchObject({ additions: 22, deletions: 6 });
  });

  test('ignores non-summary thread events (e.g. git ops)', () => {
    const gitEvent: ThreadEvent = {
      id: 'g1',
      threadId: 't1',
      type: 'git:commit',
      data: JSON.stringify({ message: 'wip' }),
      createdAt: '2026-06-15T00:00:00.000Z',
    };
    const map = sessionChangesFromEvents([gitEvent, summaryEvent('e1', 'u1', [FILE])]);
    expect([...map.keys()]).toEqual(['u1']);
  });

  test('a running session with no event yet yields no card (empty map)', () => {
    // No changed_files_summary event has been persisted while the agent runs.
    expect(sessionChangesFromEvents([]).size).toBe(0);
    expect(sessionChangesFromEvents(undefined).size).toBe(0);
  });

  test('tolerates malformed event data without throwing', () => {
    const bad: ThreadEvent = {
      id: 'b1',
      threadId: 't1',
      type: 'changed_files_summary',
      data: '{not json',
      createdAt: '2026-06-15T00:00:00.000Z',
    };
    expect(sessionChangesFromEvents([bad]).size).toBe(0);
  });
});
