/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Bun-native PTY backend — uses Bun.spawn({ terminal }) directly in-process.
 * No child helper process needed. Available on Linux/macOS (Bun ≥ 1.3.5).
 */

import type { Subprocess } from 'bun';

import { log } from '../lib/logger.js';
import type { PtyBackend, PtyBackendCallbacks } from './pty-backend.js';
import { detectShells } from './shell-detector.js';

interface PtySession {
  proc: Subprocess;
}

function resolveShell(shellId?: string): { exe: string; args: string[] } {
  if (!shellId || shellId === 'default') {
    return { exe: process.env.SHELL || 'bash', args: [] };
  }

  // Look up the shell by its detected ID
  const detected = detectShells().find((s) => s.id === shellId);
  if (detected) {
    return { exe: detected.path, args: [] };
  }

  // Fallback: try using shellId directly as an executable name
  return { exe: shellId, args: [] };
}

export class BunPtyBackend implements PtyBackend {
  readonly name = 'bun-native';
  readonly available: boolean;

  private callbacks: PtyBackendCallbacks | null = null;
  private sessions = new Map<string, PtySession>();

  constructor() {
    // Bun.spawn terminal is only available on POSIX (Linux/macOS)
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

    try {
      const callbacks = this.callbacks;
      const sessions = this.sessions;

      const proc = Bun.spawn([exe, ...args], {
        cwd: cwd || process.cwd(),
        env: ptyEnv as Record<string, string>,
        terminal: {
          cols: cols || 80,
          rows: rows || 24,
          data(_terminal, data) {
            callbacks.onData(id, data.toString());
          },
          exit(_terminal, exitCode) {
            callbacks.onExit(id, exitCode);
            sessions.delete(id);
          },
        },
      });

      this.sessions.set(id, { proc });
      log.info('Bun native PTY spawned', { namespace: 'pty-bun', ptyId: id, shell: exe });
    } catch (err: any) {
      log.error('Failed to spawn Bun native PTY', {
        namespace: 'pty-bun',
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
        // In terminal mode, proc.stdin is null — use proc.terminal.write() instead
        (session.proc as any).terminal?.write(data);
      } catch (err: any) {
        log.error('Failed to write to Bun PTY', {
          namespace: 'pty-bun',
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
        // In terminal mode, resize is on proc.terminal
        (session.proc as any).terminal?.resize(cols, rows);
      } catch (err: any) {
        log.error('Failed to resize Bun PTY', {
          namespace: 'pty-bun',
          ptyId: id,
          error: err?.message,
        });
      }
    }
  }

  signal(id: string, sig: number): void {
    const session = this.sessions.get(id);
    if (session) {
      try {
        session.proc.kill(sig);
      } catch (err: any) {
        log.error('Failed to signal Bun PTY', {
          namespace: 'pty-bun',
          ptyId: id,
          signal: sig,
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
        session.proc.kill();
      } catch {
        // process may already be gone
      }
    }
  }

  killAll(): void {
    for (const [_id, session] of this.sessions) {
      try {
        session.proc.kill();
      } catch {}
    }
    this.sessions.clear();
  }
}
