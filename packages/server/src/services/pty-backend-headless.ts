/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Headless xterm.js PTY backend — uses Bun.spawn({ terminal }) for the PTY
 * and @xterm/headless + @xterm/addon-serialize on the server to maintain
 * full terminal state (scrollback, colors, cursor position) in memory.
 *
 * This gives us:
 *   - Perfect scrollback restoration on reconnect (via serialize)
 *   - No tmux intermediary (xterm.js is the sole terminal emulator)
 *   - Session persistence across server restarts (serialize to DB on shutdown,
 *     restore headless terminal state on startup, re-spawn PTY)
 */

import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Subprocess } from 'bun';

import { log } from '../lib/logger.js';
import type { PtyBackend, PtyBackendCallbacks } from './pty-backend.js';
import { detectShells } from './shell-detector.js';

interface HeadlessSession {
  proc: Subprocess;
  headless: InstanceType<typeof HeadlessTerminal>;
  serialize: SerializeAddon;
}

function resolveShell(shellId?: string): { exe: string; args: string[] } {
  if (!shellId || shellId === 'default') {
    return { exe: process.env.SHELL || 'bash', args: [] };
  }

  const detected = detectShells().find((s) => s.id === shellId);
  if (detected) {
    return { exe: detected.path, args: [] };
  }

  return { exe: shellId, args: [] };
}

export class HeadlessPtyBackend implements PtyBackend {
  readonly name = 'headless-xterm';
  readonly available: boolean;
  readonly persistent = true;

  private callbacks: PtyBackendCallbacks | null = null;
  private sessions = new Map<string, HeadlessSession>();

  constructor() {
    this.available = process.platform !== 'win32';
  }

  init(callbacks: PtyBackendCallbacks): void {
    this.callbacks = callbacks;
  }

  spawn(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    env: Record<string, string | undefined>,
    shell?: string,
  ): void {
    if (this.sessions.has(id)) return;
    if (!this.callbacks) return;

    const { exe, args } = resolveShell(shell);
    const ptyEnv = { ...process.env, ...env };
    const effectiveCols = cols || 80;
    const effectiveRows = rows || 24;

    try {
      const callbacks = this.callbacks;
      const sessions = this.sessions;

      // Create headless xterm.js instance to track terminal state
      const headless = new HeadlessTerminal({
        cols: effectiveCols,
        rows: effectiveRows,
        scrollback: 5000,
        allowProposedApi: true,
      });
      const serialize = new SerializeAddon();
      headless.loadAddon(serialize);

      const proc = Bun.spawn([exe, ...args], {
        cwd: cwd || process.cwd(),
        env: ptyEnv as Record<string, string>,
        terminal: {
          cols: effectiveCols,
          rows: effectiveRows,
          data(_terminal, data) {
            const str = data.toString();
            // Write to headless terminal to track state
            headless.write(str);
            // Forward to client
            callbacks.onData(id, str);
          },
          exit(_terminal, exitCode) {
            callbacks.onExit(id, exitCode);
            // Cleanup headless terminal
            const session = sessions.get(id);
            if (session) {
              session.headless.dispose();
              sessions.delete(id);
            }
          },
        },
      });

      this.sessions.set(id, { proc, headless, serialize });
      log.info('Headless PTY spawned', { namespace: 'pty-headless', ptyId: id, shell: exe });
    } catch (err: any) {
      log.error('Failed to spawn headless PTY', {
        namespace: 'pty-headless',
        ptyId: id,
        error: err?.message,
      });
      this.callbacks.onError(id, err?.message ?? 'Failed to spawn terminal');
    }
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (session) {
      try {
        (session.proc as any).terminal?.write(data);
      } catch (err: any) {
        log.error('Failed to write to headless PTY', {
          namespace: 'pty-headless',
          ptyId: id,
          error: err?.message,
        });
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session) {
      try {
        (session.proc as any).terminal?.resize(cols, rows);
        session.headless.resize(cols, rows);
      } catch (err: any) {
        log.error('Failed to resize headless PTY', {
          namespace: 'pty-headless',
          ptyId: id,
          error: err?.message,
        });
      }
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.delete(id);
      try {
        session.headless.dispose();
        session.proc.kill();
      } catch {
        // process may already be gone
      }
    }
  }

  killAll(): void {
    for (const [, session] of this.sessions) {
      try {
        session.headless.dispose();
        session.proc.kill();
      } catch {}
    }
    this.sessions.clear();
  }

  /**
   * Capture full terminal state using xterm serialize addon.
   * Returns the serialized terminal content with all ANSI sequences preserved.
   */
  capturePane(id: string): string | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    try {
      return session.serialize.serialize();
    } catch (err: any) {
      log.error('Failed to serialize terminal state', {
        namespace: 'pty-headless',
        ptyId: id,
        error: err?.message,
      });
      return null;
    }
  }

  /**
   * Serialize all active sessions' terminal state and return it.
   * Called during shutdown so state can be persisted to DB.
   */
  serializeAll(): Map<string, string> {
    const states = new Map<string, string>();
    for (const [id, session] of this.sessions) {
      try {
        const state = session.serialize.serialize();
        if (state) states.set(id, state);
      } catch (err: any) {
        log.error('Failed to serialize session for persistence', {
          namespace: 'pty-headless',
          ptyId: id,
          error: err?.message,
        });
      }
    }
    return states;
  }

  /**
   * Detach all sessions — serialize state then kill processes.
   * The serialized state should be saved to DB before calling this.
   */
  detachAll(): void {
    // Kill all PTY processes but the headless state was already serialized
    for (const [, session] of this.sessions) {
      try {
        session.proc.kill();
        session.headless.dispose();
      } catch {}
    }
    this.sessions.clear();
  }

  /**
   * Restore a session from serialized terminal state.
   * Creates a new PTY + headless instance, writes the saved state to the
   * headless terminal, then the next client connect will get the restored state
   * via capturePane().
   */
  reattach(
    id: string,
    _tmuxSession: string,
    cols: number,
    rows: number,
    restoredState?: string,
    cwd?: string,
    shell?: string,
  ): void {
    if (this.sessions.has(id)) return;
    if (!this.callbacks) return;

    const { exe, args } = resolveShell(shell);
    const effectiveCols = cols || 80;
    const effectiveRows = rows || 24;

    try {
      const callbacks = this.callbacks;
      const sessions = this.sessions;

      // Create headless terminal and restore state
      const headless = new HeadlessTerminal({
        cols: effectiveCols,
        rows: effectiveRows,
        scrollback: 5000,
        allowProposedApi: true,
      });
      const serialize = new SerializeAddon();
      headless.loadAddon(serialize);

      // Write saved terminal state to headless instance
      if (restoredState) {
        headless.write(restoredState);
      }

      // Spawn a fresh PTY process
      const proc = Bun.spawn([exe, ...args], {
        cwd: cwd || process.cwd(),
        env: process.env as Record<string, string>,
        terminal: {
          cols: effectiveCols,
          rows: effectiveRows,
          data(_terminal, data) {
            const str = data.toString();
            headless.write(str);
            callbacks.onData(id, str);
          },
          exit(_terminal, exitCode) {
            callbacks.onExit(id, exitCode);
            const session = sessions.get(id);
            if (session) {
              session.headless.dispose();
              sessions.delete(id);
            }
          },
        },
      });

      this.sessions.set(id, { proc, headless, serialize });
      log.info('Headless PTY restored', {
        namespace: 'pty-headless',
        ptyId: id,
        shell: exe,
        hasState: !!restoredState,
      });
    } catch (err: any) {
      log.error('Failed to restore headless PTY', {
        namespace: 'pty-headless',
        ptyId: id,
        error: err?.message,
      });
      this.callbacks.onError(id, err?.message ?? 'Failed to restore terminal');
    }
  }
}
