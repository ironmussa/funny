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

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';

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
    runnerMode = false,
  ): Array<{ ptyId: string; cwd: string; projectId?: string; label?: string; shell?: string }> {
    const result: Array<{
      ptyId: string;
      cwd: string;
      projectId?: string;
      label?: string;
      shell?: string;
    }> = [];

    for (const [id, meta] of this.sessions) {
      // In runner mode, reattached sessions lose their userId (no DB to store it).
      // Since there's only one user per runner, adopt the first requesting userId.
      if (runnerMode && !meta.userId) {
        meta.userId = userId;
      }
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

// ── Venv activation command builder (extracted from pty-manager.ts) ──

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildVenvActivateCommand(venvPath: string, shellName: string): string | null {
  const quoted = shellSingleQuote(venvPath);
  switch (shellName) {
    case 'fish':
      return `source ${quoted}/bin/activate.fish && clear\r`;
    case 'csh':
    case 'tcsh':
      return `source ${quoted}/bin/activate.csh && clear\r`;
    case 'nu':
    case 'nushell':
    case 'powershell':
    case 'pwsh':
    case 'cmd':
      return null;
    default:
      return `source ${quoted}/bin/activate && clear\r`;
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

// ═══════════════════════════════════════════════════════════════════════
// Runner-mode session adoption
// ═══════════════════════════════════════════════════════════════════════

describe('Runner-mode session adoption', () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
  });

  test('reattached sessions with empty userId are invisible without runner mode', () => {
    // Simulate daemon reattach in non-runner mode — sessions have empty userId
    // because DB returned nothing (this shouldn't happen in non-runner mode, but
    // tests the filter logic)
    tracker.set('pty-1', { userId: '', cwd: '/home' });
    tracker.set('pty-2', { userId: '', cwd: '/work' });

    // Without runner mode, empty userId sessions are not returned
    const sessions = tracker.listForUser('user-1', false);
    expect(sessions).toHaveLength(0);
  });

  test('runner mode adopts orphaned sessions (empty userId) for the requesting user', () => {
    // Simulate daemon reattach after runtime restart in runner mode:
    // daemon reports live sessions but DB is unavailable → userId = ''
    tracker.set('pty-1', { userId: '', cwd: '/home', label: 'Terminal 1' });
    tracker.set('pty-2', { userId: '', cwd: '/work', label: 'Terminal 2' });

    // In runner mode, these orphaned sessions should be adopted
    const sessions = tracker.listForUser('user-1', true);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.ptyId).sort()).toEqual(['pty-1', 'pty-2']);
  });

  test('runner mode adoption is persistent — adopted sessions keep the userId', () => {
    tracker.set('pty-1', { userId: '', cwd: '/home' });

    // First call adopts
    tracker.listForUser('user-1', true);

    // Second call (even without runner mode) should still find them
    // because the userId was mutated in-place
    const sessions = tracker.listForUser('user-1', false);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ptyId).toBe('pty-1');
  });

  test('runner mode does not adopt sessions that already have a userId', () => {
    tracker.set('pty-1', { userId: 'user-1', cwd: '/home' });
    tracker.set('pty-2', { userId: '', cwd: '/work' });

    const sessions = tracker.listForUser('user-2', true);
    // Only pty-2 is orphaned and gets adopted by user-2
    // pty-1 belongs to user-1 and should not be returned
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ptyId).toBe('pty-2');
  });

  test('runner mode preserves metadata during adoption', () => {
    tracker.set('pty-1', {
      userId: '',
      cwd: '/home/dev',
      projectId: 'proj-1',
      label: 'Dev Terminal',
      shell: '/bin/zsh',
    });

    const sessions = tracker.listForUser('user-1', true);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      ptyId: 'pty-1',
      cwd: '/home/dev',
      projectId: 'proj-1',
      label: 'Dev Terminal',
      shell: '/bin/zsh',
    });

    // Verify the underlying meta was updated
    expect(tracker.get('pty-1')?.userId).toBe('user-1');
  });

  test('mixed: owned + orphaned sessions in runner mode', () => {
    tracker.set('pty-owned', { userId: 'user-1', cwd: '/owned' });
    tracker.set('pty-orphan', { userId: '', cwd: '/orphan' });
    tracker.set('pty-other', { userId: 'user-2', cwd: '/other' });

    const sessions = tracker.listForUser('user-1', true);
    // pty-owned: matches userId, included
    // pty-orphan: adopted by user-1, included
    // pty-other: belongs to user-2, excluded
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.ptyId).sort()).toEqual(['pty-orphan', 'pty-owned']);
  });
});

describe('buildVenvActivateCommand', () => {
  test('bash uses POSIX activate script', () => {
    expect(buildVenvActivateCommand('/proj/.venv', 'bash')).toBe(
      `source '/proj/.venv'/bin/activate && clear\r`,
    );
  });

  test('zsh uses POSIX activate script', () => {
    expect(buildVenvActivateCommand('/proj/.venv', 'zsh')).toBe(
      `source '/proj/.venv'/bin/activate && clear\r`,
    );
  });

  test('fish uses activate.fish', () => {
    expect(buildVenvActivateCommand('/proj/.venv', 'fish')).toBe(
      `source '/proj/.venv'/bin/activate.fish && clear\r`,
    );
  });

  test('tcsh uses activate.csh', () => {
    expect(buildVenvActivateCommand('/proj/.venv', 'tcsh')).toBe(
      `source '/proj/.venv'/bin/activate.csh && clear\r`,
    );
  });

  test('nushell skips activation (incompatible syntax)', () => {
    expect(buildVenvActivateCommand('/proj/.venv', 'nu')).toBeNull();
    expect(buildVenvActivateCommand('/proj/.venv', 'nushell')).toBeNull();
  });

  test('powershell skips activation', () => {
    expect(buildVenvActivateCommand('/proj/.venv', 'powershell')).toBeNull();
    expect(buildVenvActivateCommand('/proj/.venv', 'pwsh')).toBeNull();
  });

  test('paths with single quotes are shell-escaped', () => {
    // A path containing a single quote must be escaped so the shell sources
    // the right file rather than breaking out of the quoted string.
    expect(buildVenvActivateCommand(`/weird/it's/.venv`, 'bash')).toBe(
      `source '/weird/it'\\''s/.venv'/bin/activate && clear\r`,
    );
  });

  test('paths with spaces are quoted', () => {
    expect(buildVenvActivateCommand('/path with spaces/.venv', 'bash')).toBe(
      `source '/path with spaces/.venv'/bin/activate && clear\r`,
    );
  });
});

// ── Output coalescing (extracted from pty-manager.ts) ────────────────
//
// The production version wires onData → wsBroker through this same
// state machine; here we extract it so the timer + size thresholds can
// be tested deterministically without a real WebSocket.

type FlushReason = 'size' | 'timer' | 'close';

interface CoalesceBuf {
  chunks: string[];
  bytes: number;
  chunkCount: number;
  timer: ReturnType<typeof setTimeout> | null;
}

class OutputCoalescer {
  private buffers = new Map<string, CoalesceBuf>();

  constructor(
    private readonly flushBytes: number,
    private readonly flushMs: number,
    private readonly emit: (
      ptyId: string,
      data: string,
      info: { reason: FlushReason; chunks: number; bytes: number },
    ) => void,
  ) {}

  enqueue(ptyId: string, data: string): void {
    let buf = this.buffers.get(ptyId);
    if (!buf) {
      buf = { chunks: [], bytes: 0, chunkCount: 0, timer: null };
      this.buffers.set(ptyId, buf);
    }
    buf.chunks.push(data);
    buf.bytes += data.length;
    buf.chunkCount += 1;
    if (buf.bytes >= this.flushBytes) {
      this.flush(ptyId, 'size');
      return;
    }
    if (!buf.timer) {
      buf.timer = setTimeout(() => this.flush(ptyId, 'timer'), this.flushMs);
    }
  }

  flush(ptyId: string, reason: FlushReason): void {
    const buf = this.buffers.get(ptyId);
    if (!buf || buf.chunks.length === 0) return;
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }
    const data = buf.chunks.length === 1 ? buf.chunks[0] : buf.chunks.join('');
    const chunkCount = buf.chunkCount;
    const byteCount = buf.bytes;
    this.buffers.delete(ptyId);
    this.emit(ptyId, data, { reason, chunks: chunkCount, bytes: byteCount });
  }

  drop(ptyId: string): void {
    const buf = this.buffers.get(ptyId);
    if (!buf) return;
    if (buf.timer) clearTimeout(buf.timer);
    this.buffers.delete(ptyId);
  }

  flushAll(reason: FlushReason): void {
    for (const ptyId of this.buffers.keys()) this.flush(ptyId, reason);
  }

  get pendingCount(): number {
    return this.buffers.size;
  }
}

describe('OutputCoalescer', () => {
  type Emitted = {
    ptyId: string;
    data: string;
    info: { reason: FlushReason; chunks: number; bytes: number };
  };
  let emitted: Emitted[];
  let coalescer: OutputCoalescer;

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    coalescer = new OutputCoalescer(64, 8, (ptyId, data, info) => {
      emitted.push({ ptyId, data, info });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('enqueue under threshold and timer does not emit immediately', () => {
    coalescer.enqueue('pty-1', 'hi');
    expect(emitted).toHaveLength(0);
  });

  test('multiple small chunks coalesce into a single emit on timer', () => {
    coalescer.enqueue('pty-1', 'hel');
    coalescer.enqueue('pty-1', 'lo ');
    coalescer.enqueue('pty-1', 'world');
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(8);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].data).toBe('hello world');
    expect(emitted[0].info.reason).toBe('timer');
    expect(emitted[0].info.chunks).toBe(3);
    expect(emitted[0].info.bytes).toBe(11);
  });

  test('reaching flushBytes triggers immediate size flush', () => {
    // 64 byte threshold, push 70 in one call
    coalescer.enqueue('pty-1', 'a'.repeat(70));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].info.reason).toBe('size');
    expect(emitted[0].data.length).toBe(70);
  });

  test('size flush after partial fill emits and resets', () => {
    coalescer.enqueue('pty-1', 'a'.repeat(30));
    coalescer.enqueue('pty-1', 'b'.repeat(40)); // total 70 ≥ 64
    expect(emitted).toHaveLength(1);
    expect(emitted[0].info.reason).toBe('size');
    expect(emitted[0].info.chunks).toBe(2);
    expect(emitted[0].data).toBe('a'.repeat(30) + 'b'.repeat(40));

    // Buffer should be empty now — next chunk waits for the timer again
    coalescer.enqueue('pty-1', 'next');
    expect(emitted).toHaveLength(1);
    vi.advanceTimersByTime(8);
    expect(emitted).toHaveLength(2);
    expect(emitted[1].data).toBe('next');
  });

  test('close flush drains pending data with reason=close', () => {
    coalescer.enqueue('pty-1', 'final');
    coalescer.flush('pty-1', 'close');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].info.reason).toBe('close');
    expect(emitted[0].data).toBe('final');
  });

  test('drop clears timer without emitting', () => {
    coalescer.enqueue('pty-1', 'discarded');
    coalescer.drop('pty-1');
    vi.advanceTimersByTime(100);
    expect(emitted).toHaveLength(0);
    expect(coalescer.pendingCount).toBe(0);
  });

  test('flush on unknown ptyId is a no-op', () => {
    coalescer.flush('nonexistent', 'close');
    expect(emitted).toHaveLength(0);
  });

  test('per-pty isolation — flushing one does not flush another', () => {
    coalescer.enqueue('pty-1', 'one');
    coalescer.enqueue('pty-2', 'two');
    coalescer.flush('pty-1', 'close');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].ptyId).toBe('pty-1');
    expect(coalescer.pendingCount).toBe(1);

    vi.advanceTimersByTime(8);
    expect(emitted).toHaveLength(2);
    expect(emitted[1].ptyId).toBe('pty-2');
    expect(emitted[1].data).toBe('two');
  });

  test('flushAll drains every pending buffer', () => {
    coalescer.enqueue('pty-1', 'a');
    coalescer.enqueue('pty-2', 'b');
    coalescer.enqueue('pty-3', 'c');
    coalescer.flushAll('close');
    expect(emitted).toHaveLength(3);
    expect(emitted.every((e) => e.info.reason === 'close')).toBe(true);
  });
});
