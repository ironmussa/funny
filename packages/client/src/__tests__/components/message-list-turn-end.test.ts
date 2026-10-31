import { describe, expect, test } from 'vitest';

import { buildVirtualRows } from '@/components/thread/MemoizedMessageList.virtualRows';
import type { RenderItem } from '@/lib/render-items';

const message = (id: string, role: string, content: string, timestamp: string): RenderItem => ({
  type: 'message',
  msg: { id, role, content, timestamp },
});

describe('buildVirtualRows turn-end bars', () => {
  test('closes every finished turn above the next prompt, leaving the last one to the status tail', () => {
    const items: RenderItem[] = [
      message('u1', 'user', 'First prompt', '2026-10-30T20:00:00.000Z'),
      {
        type: 'toolcall',
        tc: { id: 'tc1', name: 'Read', input: '{}', timestamp: '2026-10-30T20:00:05.000Z' },
      } as RenderItem,
      message('a1', 'assistant', 'First answer', '2026-10-30T20:00:30.000Z'),
      message('u2', 'user', 'Second prompt', '2026-10-30T20:05:00.000Z'),
      message('a2', 'assistant', 'Second answer', '2026-10-30T20:05:10.000Z'),
    ];

    const rows = buildVirtualRows(items);
    const turnEnds = rows.filter((row) => row.type === 'turn-end');

    expect(rows.map((row) => row.key)).toEqual(['u1', 'tc1', 'a1', 'turn-end-u1', 'u2', 'a2']);
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]).toMatchObject({
      startedAt: '2026-10-30T20:00:00.000Z',
      completedAt: '2026-10-30T20:00:30.000Z',
    });
    // Copy covers the prompt and text replies only — no tool cards.
    expect(turnEnds[0].type === 'turn-end' && turnEnds[0].messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
    ]);
  });
});
