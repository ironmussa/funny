/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * tmux-based PTY backend — sessions survive server restarts.
 * Spawns tmux sessions and attaches via Bun.spawn({ terminal }) to pipe I/O.
 * When tmux is not installed, `available` is false and pty-manager falls back.
 */

import type { Subprocess } from 'bun';

import { log } from '../lib/logger.js';
import type { PtyBackend, PtyBackendCallbacks } from './pty-backend.js';
import { detectShells } from './shell-detector.js';

const TMUX_PREFIX = 'funny-';

/**
 * Regex to strip alternate-screen enter/exit escape sequences.
 * tmux attach sends these to switch the outer terminal into alt-screen mode,
 * which disables xterm.js native scrollback.  By filtering them out, xterm.js
 * keeps its own scrollback buffer and mouse-wheel scrolling works normally.
 *
 * Matches: \e[?1049h, \e[?1049l, \e[?1047h, \e[?1047l, \e[?47h, \e[?47l
 */
// eslint-disable-next-line no-control-regex
const ALT_SCREEN_RE = /\x1b\[\?(?:1049|1047|47)[hl]/g;

interface TmuxSession {
  /** The attach process that pipes tmux output to our callbacks */
  attachProc: Subprocess;
  tmuxSession: string;
}

function resolveShell(shellId?: string): string {
  if (!shellId || shellId === 'default') {
    return process.env.SHELL || 'bash';
  }
  const detected = detectShells().find((s) => s.id === shellId);
  const resolved = detected?.path ?? shellId;

  // Prevent running tmux inside tmux — fall back to default shell
  const basename = resolved.split('/').pop() ?? '';
  if (basename === 'tmux' || basename === 'screen') {
    return process.env.SHELL || 'bash';
  }

  return resolved;
}

function tmuxSessionName(id: string): string {
  return `${TMUX_PREFIX}${id}`;
}

export class TmuxPtyBackend implements PtyBackend {
  readonly name = 'tmux';
  readonly available: boolean;
  readonly persistent = true;

  private tmuxPath: string;
  private callbacks: PtyBackendCallbacks | null = null;
  private sessions = new Map<string, TmuxSession>();
  private isShuttingDown = false;

  constructor() {
    // Check if tmux is installed
    try {
      const result = Bun.spawnSync(['which', 'tmux']);
      const path = result.stdout.toString().trim();
      this.available = result.exitCode === 0 && path.length > 0;
      this.tmuxPath = path || 'tmux';
    } catch {
      this.available = false;
      this.tmuxPath = 'tmux';
    }
  }

  init(callbacks: PtyBackendCallbacks): void {
    this.callbacks = callbacks;
  }

  spawn(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    _env: Record<string, string | undefined>,
    shell?: string,
  ): void {
    if (this.sessions.has(id)) return;
    if (!this.callbacks) return;

    const tmuxName = tmuxSessionName(id);
    const shellExe = resolveShell(shell);

    try {
      // Check if session already exists
      const hasSession =
        Bun.spawnSync([this.tmuxPath, 'has-session', '-t', tmuxName]).exitCode === 0;

      if (!hasSession) {
        // Create a new detached tmux session with the correct initial directory
        const createResult = Bun.spawnSync(
          [
            this.tmuxPath,
            'new-session',
            '-d',
            '-s',
            tmuxName,
            '-x',
            String(cols || 80),
            '-y',
            String(rows || 24),
            '-c',
            cwd || process.cwd(),
            shellExe,
          ],
          {
            env: process.env as Record<string, string>,
          },
        );

        if (createResult.exitCode !== 0) {
          const stderr = createResult.stderr.toString().trim();
          throw new Error(`tmux new-session failed (exit ${createResult.exitCode}): ${stderr}`);
        }

        // Increase the scrollback history buffer for the session.
        Bun.spawnSync([this.tmuxPath, 'set-option', '-t', tmuxName, 'history-limit', '10000']);
        // Hide the tmux status bar — the app has its own tab UI.
        Bun.spawnSync([this.tmuxPath, 'set-option', '-t', tmuxName, 'status', 'off']);
      }

      // Verify the session was registered before attempting to attach
      const verifyResult = Bun.spawnSync([this.tmuxPath, 'has-session', '-t', tmuxName]);

      if (verifyResult.exitCode !== 0) {
        throw new Error(`tmux session created but not found: ${tmuxName}`);
      }

      // Attach to the tmux session via a PTY subprocess
      this.attachToSession(id, tmuxName, cols, rows);

      log.info('tmux session created', { namespace: 'pty-tmux', ptyId: id, tmuxSession: tmuxName });
    } catch (err: any) {
      log.error('Failed to spawn tmux session', {
        namespace: 'pty-tmux',
        ptyId: id,
        error: err?.message,
      });
      this.callbacks.onError(id, err?.message ?? 'Failed to spawn tmux terminal');
    }
  }

  reattach(id: string, tmuxSession: string, cols: number, rows: number): void {
    if (this.sessions.has(id)) return;
    if (!this.callbacks) return;

    try {
      // Verify the tmux session still exists
      const checkResult = Bun.spawnSync([this.tmuxPath, 'has-session', '-t', tmuxSession]);

      if (checkResult.exitCode !== 0) {
        log.warn('tmux session no longer exists', {
          namespace: 'pty-tmux',
          ptyId: id,
          tmuxSession,
        });
        this.callbacks.onExit(id, 0);
        return;
      }

      // Ensure history-limit and status bar are configured for reattached sessions.
      Bun.spawnSync([this.tmuxPath, 'set-option', '-t', tmuxSession, 'history-limit', '10000']);
      Bun.spawnSync([this.tmuxPath, 'set-option', '-t', tmuxSession, 'status', 'off']);

      this.attachToSession(id, tmuxSession, cols, rows);
      log.info('Reattached to tmux session', {
        namespace: 'pty-tmux',
        ptyId: id,
        tmuxSession,
      });
    } catch (err: any) {
      log.error('Failed to reattach tmux session', {
        namespace: 'pty-tmux',
        ptyId: id,
        error: err?.message,
      });
      this.callbacks?.onError(id, err?.message ?? 'Failed to reattach to tmux session');
    }
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (session) {
      try {
        (session.attachProc as any).terminal?.write(data);
      } catch (err: any) {
        log.error('Failed to write to tmux PTY', {
          namespace: 'pty-tmux',
          ptyId: id,
          error: err?.message,
        });
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) return;

    try {
      // Resize the tmux window
      Bun.spawnSync([
        this.tmuxPath,
        'resize-window',
        '-t',
        session.tmuxSession,
        '-x',
        String(cols),
        '-y',
        String(rows),
      ]);
      // Also resize the attach PTY
      (session.attachProc as any).terminal?.resize(cols, rows);
    } catch (err: any) {
      log.error('Failed to resize tmux PTY', {
        namespace: 'pty-tmux',
        ptyId: id,
        error: err?.message,
      });
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    this.sessions.delete(id);

    // Kill the tmux session (this also terminates the attach process)
    try {
      Bun.spawnSync([this.tmuxPath, 'kill-session', '-t', session.tmuxSession]);
    } catch {
      // Session may already be gone
    }

    // Also kill the attach process in case tmux kill didn't do it
    try {
      session.attachProc.kill();
    } catch {
      // Process may already be gone
    }
  }

  killAll(): void {
    for (const [_id, session] of this.sessions) {
      try {
        Bun.spawnSync([this.tmuxPath, 'kill-session', '-t', session.tmuxSession]);
      } catch {}
      try {
        session.attachProc.kill();
      } catch {}
    }
    this.sessions.clear();
  }

  detachAll(): void {
    this.isShuttingDown = true;
    // Kill only the attach processes, leave tmux sessions running
    for (const [, session] of this.sessions) {
      try {
        session.attachProc.kill();
      } catch {}
    }
    this.sessions.clear();
  }

  capturePane(id: string): string | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    try {
      // Capture the full scrollback history plus visible pane content.
      // -p prints to stdout, -e includes escape sequences, -t targets the session.
      // -S - starts from the beginning of the scrollback buffer.
      const result = Bun.spawnSync([
        this.tmuxPath,
        'capture-pane',
        '-t',
        session.tmuxSession,
        '-p',
        '-e',
        '-S',
        '-',
      ]);

      if (result.exitCode !== 0) {
        log.warn('tmux capture-pane failed', {
          namespace: 'pty-tmux',
          ptyId: id,
          exitCode: result.exitCode,
        });
        return null;
      }

      return result.stdout.toString();
    } catch (err: any) {
      log.error('Failed to capture tmux pane', {
        namespace: 'pty-tmux',
        ptyId: id,
        error: err?.message,
      });
      return null;
    }
  }

  /** Attach to an existing tmux session via a PTY subprocess. */
  private attachToSession(id: string, tmuxName: string, cols: number, rows: number): void {
    if (!this.callbacks) return;

    const callbacks = this.callbacks;
    const sessions = this.sessions;
    const tmuxPath = this.tmuxPath;

    log.info('Attaching to tmux session', {
      namespace: 'pty-tmux',
      ptyId: id,
      tmuxSession: tmuxName,
      cols,
      rows,
      tmuxPath,
    });

    const isShuttingDown = () => this.isShuttingDown;
    const attachProc = Bun.spawn([tmuxPath, 'attach-session', '-t', tmuxName], {
      env: process.env as Record<string, string>,
      terminal: {
        cols: cols || 80,
        rows: rows || 24,
        data(_terminal, data) {
          // Strip alternate-screen sequences so xterm.js keeps its
          // native scrollback buffer instead of switching to alt-screen.
          const raw = data.toString();
          const filtered = raw.replace(ALT_SCREEN_RE, '');
          if (filtered.length > 0) {
            callbacks.onData(id, filtered);
          }
        },
        exit(_terminal, exitCode) {
          if (isShuttingDown()) return;
          log.info('tmux attach process exited', {
            namespace: 'pty-tmux',
            ptyId: id,
            tmuxSession: tmuxName,
            exitCode,
          });
          callbacks.onExit(id, exitCode);
          sessions.delete(id);
        },
      },
    });

    sessions.set(id, { attachProc, tmuxSession: tmuxName });
  }
}
