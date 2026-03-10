/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * node-pty PTY backend — uses a separate Node.js helper process that
 * communicates via NDJSON over stdin/stdout. Used on Windows where
 * Bun's native terminal API is not available.
 */

import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { createInterface } from 'readline';

import { log } from '../lib/logger.js';
import type { PtyBackend, PtyBackendCallbacks } from './pty-backend.js';

export class NodePtyBackend implements PtyBackend {
  readonly name = 'node-pty';
  readonly available: boolean;

  private callbacks: PtyBackendCallbacks | null = null;
  private helperProcess: ChildProcess | null = null;
  private helperStdin: any = null;
  private activeSessions = new Set<string>();

  constructor() {
    // Check if node-pty is loadable
    this.available = NodePtyBackend.probe();
  }

  private static probe(): boolean {
    try {
      require.resolve('node-pty');
      return true;
    } catch {
      return false;
    }
  }

  init(callbacks: PtyBackendCallbacks): void {
    this.callbacks = callbacks;
  }

  private ensureHelper(): void {
    if (this.helperProcess && !this.helperProcess.killed) return;

    const helperPath = join(import.meta.dir, 'pty-helper.mjs');
    log.info('Spawning PTY helper process (node-pty)', { namespace: 'pty-node-pty', helperPath });

    this.helperProcess = spawn('node', [helperPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.helperStdin = this.helperProcess.stdin;

    // Forward helper's stderr to server's stderr
    if (this.helperProcess.stderr) {
      this.helperProcess.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
      });
    }

    if (this.helperProcess.stdout) {
      const rl = createInterface({
        input: this.helperProcess.stdout,
        terminal: false,
      });

      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          this.handleHelperMessage(msg);
        } catch (err) {
          log.error('Failed to parse PTY helper output', {
            namespace: 'pty-node-pty',
            line,
            error: err,
          });
        }
      });
    }

    this.helperProcess.on('exit', (code) => {
      log.warn('PTY helper process exited', { namespace: 'pty-node-pty', exitCode: code });

      // Notify all active sessions that the helper crashed
      if (this.callbacks) {
        for (const ptyId of this.activeSessions) {
          this.callbacks.onError(ptyId, 'Terminal helper process crashed unexpectedly');
        }
      }
      this.activeSessions.clear();
      this.helperProcess = null;
      this.helperStdin = null;
    });
  }

  private handleHelperMessage(msg: any): void {
    if (!this.callbacks) return;

    const { type, data } = msg;

    switch (type) {
      case 'pty:data':
        if (data.ptyId) {
          this.callbacks.onData(data.ptyId, data.data);
        }
        break;

      case 'pty:exit':
        if (data.ptyId) {
          this.callbacks.onExit(data.ptyId, data.exitCode ?? 0);
          this.activeSessions.delete(data.ptyId);
        }
        break;

      case 'pty:error':
        if (data.ptyId) {
          this.callbacks.onError(data.ptyId, data.error ?? 'Unknown PTY error');
          this.activeSessions.delete(data.ptyId);
        }
        break;
    }
  }

  private sendToHelper(type: string, args: any): void {
    this.ensureHelper();
    if (this.helperStdin) {
      this.helperStdin.write(JSON.stringify({ type, ...args }) + '\n');
    }
  }

  spawn(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    env: Record<string, string | undefined>,
    shell?: string,
  ): void {
    if (this.activeSessions.has(id)) return;

    log.info('Requesting spawn PTY via node-pty helper', {
      namespace: 'pty-node-pty',
      ptyId: id,
      shell,
    });
    this.activeSessions.add(id);
    this.sendToHelper('spawn', { id, cwd, cols, rows, env, shell });
  }

  write(id: string, data: string): void {
    this.sendToHelper('write', { id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    this.sendToHelper('resize', { id, cols, rows });
  }

  kill(id: string): void {
    log.info('Requesting kill PTY', { namespace: 'pty-node-pty', ptyId: id });
    this.sendToHelper('kill', { id });
    this.activeSessions.delete(id);
  }

  killAll(): void {
    if (this.helperProcess) {
      if (process.platform === 'win32' && this.helperProcess.pid) {
        try {
          const r = Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${this.helperProcess.pid}`]);
          if (r.exitCode !== 0) this.helperProcess.kill();
        } catch {
          try {
            this.helperProcess.kill();
          } catch {}
        }
      } else {
        this.helperProcess.kill();
      }
      this.helperProcess = null;
      this.helperStdin = null;
    }
    this.activeSessions.clear();
  }
}
