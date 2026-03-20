/**
 * PTY Manager unit tests — pure logic, no DB dependencies.
 *
 * Since the real pty-manager.ts has module-level side effects (backend selection,
 * backend.init(), shutdownManager.register()), we recreate the core logic here
 * in isolation — same pattern as ws-broker.test.ts.
 *
 * Tests cover:
 *   1. Scrollback ring buffer (append, drain, clear, eviction)
 *   2. Session tracking (add, remove, list with user filtering)
 *   3. Spawn duplicate detection / auto-restore
 *   4. Kill cleanup
 */

import { describe, test, expect, beforeEach } from 'vitest';

// ── Scrollback ring buffer (extracted from pty-manager.ts) ──────────

const MAX_SCROLLBACK_BYTES = 128 * 1024; // 128 KB per session

class ScrollbackBuffer {
  private buffers = new Map<string, string[]>();
  private sizes = new Map<string, number>();

  append(ptyId: string, data: string): void {
    let chunks = this.buffers.get(ptyId);
    let size = this.sizes.get(ptyId) ?? 0;
    if (!chunks) {
      chunks = [];
      this.buffers.set(ptyId, chunks);
    }
    chunks.push(data);
    size += data.length;
    // Evict oldest chunks when over budget
    while (size > MAX_SCROLLBACK_BYTES && chunks.length > 1) {
      size -= chunks.shift()!.length;
    }
    this.sizes.set(ptyId, size);
  }

  drain(ptyId: string): string | null {
    const chunks = this.buffers.get(ptyId);
    if (!chunks || chunks.length === 0) return null;
    return chunks.join('');
  }

  clear(ptyId: string): void {
    this.buffers.delete(ptyId);
    this.sizes.delete(ptyId);
  }

  get bufferCount(): number {
    return this.buffers.size;
  }
}

// ── Session tracking (extracted from pty-manager.ts) ─────────────────

interface SessionMeta {
  userId: string;
  cwd: string;
  projectId?: string;
  label?: string;
  tmuxSession?: string;
  shell?: string;
}

class SessionTracker {
  private sessions = new Map<string, SessionMeta>();

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get(id: string): SessionMeta | undefined {
    return this.sessions.get(id);
  }

  set(id: string, meta: SessionMeta): void {
    this.sessions.set(id, meta);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  clear(): void {
    this.sessions.clear();
  }

  listForUser(
    userId: string,
  ): Array<{ ptyId: string; cwd: string; projectId?: string; label?: string; shell?: string }> {
    const result: Array<{
      ptyId: string;
      cwd: string;
      projectId?: string;
      label?: string;
      shell?: string;
    }> = [];

    for (const [id, meta] of this.sessions) {
      if (meta.userId === userId) {
        result.push({
          ptyId: id,
          cwd: meta.cwd,
          projectId: meta.projectId,
          label: meta.label,
          shell: meta.shell,
        });
      }
    }

    return result;
  }

  get size(): number {
    return this.sessions.size;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe('ScrollbackBuffer', () => {
  let scrollback: ScrollbackBuffer;

  beforeEach(() => {
    scrollback = new ScrollbackBuffer();
  });

  test('drain returns null for unknown ptyId', () => {
    expect(scrollback.drain('nonexistent')).toBeNull();
  });

  test('append + drain returns accumulated data', () => {
    scrollback.append('pty-1', 'hello ');
    scrollback.append('pty-1', 'world');

    expect(scrollback.drain('pty-1')).toBe('hello world');
  });

  test('drain returns data without clearing', () => {
    scrollback.append('pty-1', 'data');
    expect(scrollback.drain('pty-1')).toBe('data');
    // drain is non-destructive
    expect(scrollback.drain('pty-1')).toBe('data');
  });

  test('clear removes all data for a ptyId', () => {
    scrollback.append('pty-1', 'data');
    scrollback.clear('pty-1');
    expect(scrollback.drain('pty-1')).toBeNull();
  });

  test('clear on unknown ptyId is a no-op', () => {
    scrollback.clear('nonexistent');
    expect(scrollback.bufferCount).toBe(0);
  });

  test('separate ptyIds are independent', () => {
    scrollback.append('pty-1', 'alpha');
    scrollback.append('pty-2', 'beta');

    expect(scrollback.drain('pty-1')).toBe('alpha');
    expect(scrollback.drain('pty-2')).toBe('beta');

    scrollback.clear('pty-1');
    expect(scrollback.drain('pty-1')).toBeNull();
    expect(scrollback.drain('pty-2')).toBe('beta');
  });

  test('evicts oldest chunks when exceeding MAX_SCROLLBACK_BYTES', () => {
    // Fill with chunks that together exceed 128KB
    const chunkSize = 32 * 1024; // 32 KB per chunk
    const chunk = 'A'.repeat(chunkSize);

    // 5 chunks × 32KB = 160KB > 128KB limit
    for (let i = 0; i < 5; i++) {
      scrollback.append('pty-1', chunk);
    }

    const result = scrollback.drain('pty-1')!;
    expect(result).not.toBeNull();
    // Should have evicted at least the first chunk
    expect(result.length).toBeLessThanOrEqual(MAX_SCROLLBACK_BYTES);
    // At least 4 chunks worth should remain (128KB fits 4 × 32KB)
    expect(result.length).toBeGreaterThanOrEqual(chunkSize * 4);
  });

  test('eviction keeps at least 1 chunk even if it exceeds limit', () => {
    // Single chunk larger than the limit
    const bigChunk = 'X'.repeat(MAX_SCROLLBACK_BYTES + 1024);
    scrollback.append('pty-1', bigChunk);

    // The single chunk is kept because we only evict when chunks.length > 1
    const result = scrollback.drain('pty-1')!;
    expect(result).toBe(bigChunk);
  });

  test('eviction removes only enough chunks to get under budget', () => {
    const chunkSize = 50 * 1024; // 50 KB
    const chunk = 'B'.repeat(chunkSize);

    // 3 chunks × 50KB = 150KB > 128KB
    scrollback.append('pty-1', chunk);
    scrollback.append('pty-1', chunk);
    scrollback.append('pty-1', chunk);

    const result = scrollback.drain('pty-1')!;
    // After evicting first chunk: 2 × 50KB = 100KB ≤ 128KB → stops evicting
    expect(result.length).toBe(chunkSize * 2);
  });
});

describe('SessionTracker', () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
  });

  test('starts empty', () => {
    expect(tracker.size).toBe(0);
    expect(tracker.has('pty-1')).toBe(false);
  });

  test('set/get/has work correctly', () => {
    tracker.set('pty-1', { userId: 'user-1', cwd: '/home/user' });
    expect(tracker.has('pty-1')).toBe(true);
    expect(tracker.get('pty-1')).toEqual({ userId: 'user-1', cwd: '/home/user' });
    expect(tracker.size).toBe(1);
  });

  test('delete removes a session', () => {
    tracker.set('pty-1', { userId: 'user-1', cwd: '/home' });
    tracker.delete('pty-1');
    expect(tracker.has('pty-1')).toBe(false);
    expect(tracker.size).toBe(0);
  });

  test('delete on nonexistent is a no-op', () => {
    tracker.delete('nonexistent');
    expect(tracker.size).toBe(0);
  });

  test('clear removes all sessions', () => {
    tracker.set('pty-1', { userId: 'user-1', cwd: '/a' });
    tracker.set('pty-2', { userId: 'user-2', cwd: '/b' });
    tracker.clear();
    expect(tracker.size).toBe(0);
  });

  test('listForUser returns only sessions for the given userId', () => {
    tracker.set('pty-1', {
      userId: 'user-1',
      cwd: '/home/user1',
      projectId: 'proj-1',
      label: 'Terminal 1',
      shell: '/bin/bash',
    });
    tracker.set('pty-2', {
      userId: 'user-2',
      cwd: '/home/user2',
      projectId: 'proj-2',
    });
    tracker.set('pty-3', {
      userId: 'user-1',
      cwd: '/home/user1/work',
      label: 'Terminal 2',
    });

    const user1Sessions = tracker.listForUser('user-1');
    expect(user1Sessions).toHaveLength(2);
    expect(user1Sessions).toEqual(
      expect.arrayContaining([
        {
          ptyId: 'pty-1',
          cwd: '/home/user1',
          projectId: 'proj-1',
          label: 'Terminal 1',
          shell: '/bin/bash',
        },
        {
          ptyId: 'pty-3',
          cwd: '/home/user1/work',
          projectId: undefined,
          label: 'Terminal 2',
          shell: undefined,
        },
      ]),
    );

    const user2Sessions = tracker.listForUser('user-2');
    expect(user2Sessions).toHaveLength(1);
    expect(user2Sessions[0].ptyId).toBe('pty-2');
  });

  test('listForUser returns empty for unknown user', () => {
    tracker.set('pty-1', { userId: 'user-1', cwd: '/home' });
    expect(tracker.listForUser('nonexistent')).toEqual([]);
  });

  test('listForUser omits undefined optional fields', () => {
    tracker.set('pty-1', { userId: 'user-1', cwd: '/home' });
    const sessions = tracker.listForUser('user-1');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      ptyId: 'pty-1',
      cwd: '/home',
      projectId: undefined,
      label: undefined,
      shell: undefined,
    });
  });
});

describe('Spawn duplicate detection', () => {
  let tracker: SessionTracker;
  let scrollback: ScrollbackBuffer;
  let spawnCalls: string[];
  let restoreEvents: Array<{ ptyId: string; data: string }>;

  // Simulate spawnPty behavior
  function spawnPty(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    userId: string,
    shell?: string,
    projectId?: string,
    label?: string,
  ): void {
    if (tracker.has(id)) {
      // Duplicate detected — send restore instead of spawning
      const content = scrollback.drain(id) ?? '';
      restoreEvents.push({ ptyId: id, data: content });
      return;
    }

    spawnCalls.push(id);
    tracker.set(id, { userId, cwd, projectId, label, shell });
  }

  beforeEach(() => {
    tracker = new SessionTracker();
    scrollback = new ScrollbackBuffer();
    spawnCalls = [];
    restoreEvents = [];
  });

  test('first spawn calls the backend', () => {
    spawnPty('pty-1', '/home', 80, 24, 'user-1');
    expect(spawnCalls).toEqual(['pty-1']);
    expect(restoreEvents).toHaveLength(0);
  });

  test('duplicate spawn sends restore instead of spawning again', () => {
    spawnPty('pty-1', '/home', 80, 24, 'user-1');
    scrollback.append('pty-1', 'previous output');

    // Try to spawn the same ID again (e.g. browser refresh)
    spawnPty('pty-1', '/home', 80, 24, 'user-1');

    expect(spawnCalls).toEqual(['pty-1']); // Only 1 spawn call
    expect(restoreEvents).toHaveLength(1);
    expect(restoreEvents[0]).toEqual({
      ptyId: 'pty-1',
      data: 'previous output',
    });
  });

  test('duplicate spawn sends empty string when no scrollback', () => {
    spawnPty('pty-1', '/home', 80, 24, 'user-1');

    // No scrollback data
    spawnPty('pty-1', '/home', 80, 24, 'user-1');

    expect(restoreEvents).toHaveLength(1);
    expect(restoreEvents[0].data).toBe('');
  });
});

describe('Kill cleanup', () => {
  let tracker: SessionTracker;
  let scrollback: ScrollbackBuffer;
  let killedIds: string[];

  function killPty(id: string): void {
    killedIds.push(id);
    tracker.delete(id);
    scrollback.clear(id);
  }

  function killAllPtys(): void {
    tracker.clear();
  }

  beforeEach(() => {
    tracker = new SessionTracker();
    scrollback = new ScrollbackBuffer();
    killedIds = [];
  });

  test('killPty removes session and scrollback', () => {
    tracker.set('pty-1', { userId: 'user-1', cwd: '/home' });
    scrollback.append('pty-1', 'data');

    killPty('pty-1');

    expect(tracker.has('pty-1')).toBe(false);
    expect(scrollback.drain('pty-1')).toBeNull();
    expect(killedIds).toEqual(['pty-1']);
  });

  test('killAllPtys clears all sessions', () => {
    tracker.set('pty-1', { userId: 'user-1', cwd: '/a' });
    tracker.set('pty-2', { userId: 'user-2', cwd: '/b' });

    killAllPtys();

    expect(tracker.size).toBe(0);
  });
});
