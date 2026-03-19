/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * PTY backend that delegates to the persistent PTY daemon process.
 * The daemon owns the actual PTY processes and survives server restarts.
 * This backend communicates with the daemon via NDJSON over a Unix socket.
 */

import { log } from '../lib/logger.js';
import type { PtyBackend, PtyBackendCallbacks } from './pty-backend.js';
import { ensureDaemonRunning, SOCKET_PATH } from './pty-daemon-launcher.js';

/** Pending capture requests waiting for a response from the daemon. */
interface PendingCapture {
  resolve: (state: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DaemonPtyBackend implements PtyBackend {
  readonly name = 'daemon';
  readonly available: boolean;
  readonly persistent = true;

  private callbacks: PtyBackendCallbacks | null = null;
  private socket: import('bun').Socket | null = null;
  private lineBuffer = '';
  private connected = false;
  private reconnecting = false;
  private pendingCaptures = new Map<string, PendingCapture>();
  private pendingList: ((sessions: any[]) => void) | null = null;
  /** Queue of messages to send once connected. */
  private sendQueue: string[] = [];
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_BASE_MS = 2000;

  constructor() {
    // Available on POSIX only (Unix sockets)
    this.available = process.platform !== 'win32';
  }

  init(callbacks: PtyBackendCallbacks): void {
    this.callbacks = callbacks;
    // Start connection asynchronously — don't block init
    this.connectToDaemon();
  }

  spawn(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    env: Record<string, string | undefined>,
    shell?: string,
  ): void {
    this.send({
      cmd: 'spawn',
      id,
      cwd,
      cols,
      rows,
      shell,
      env: env as Record<string, string>,
    });
  }

  write(id: string, data: string): void {
    this.send({ cmd: 'write', id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ cmd: 'resize', id, cols, rows });
  }

  kill(id: string): void {
    this.send({ cmd: 'kill', id });
  }

  killAll(): void {
    // Kill via daemon — list sessions then kill each
    // For simplicity, send shutdown (will kill all sessions)
    this.send({ cmd: 'shutdown' });
  }

  capturePane(_id: string): string | null {
    // capturePane is synchronous in the interface but the daemon is async.
    // We use a blocking approach: send capture command and wait synchronously.
    // However, since we can't truly block in JS, we return null and the
    // pty-manager falls back to its scrollback buffer for non-persistent captures.
    // For the restore flow, we use capturePaneAsync instead.

    // Try synchronous capture from pending result if already available
    return null;
  }

  /**
   * Async capture — used during reattach/restore flows.
   */
  async capturePaneAsync(id: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCaptures.delete(id);
        resolve(null);
      }, 5000);

      this.pendingCaptures.set(id, { resolve, timer });
      this.send({ cmd: 'capture', id });
    });
  }

  /**
   * On server restart: connect to existing daemon and discover active sessions.
   * The pty-manager calls this for each persisted session from the DB.
   */
  reattach(
    _id: string,
    _tmuxSession: string,
    _cols: number,
    _rows: number,
    _restoredState?: string,
    _cwd?: string,
    _shell?: string,
  ): void {
    // For the daemon backend, reattach is a no-op per-session.
    // The daemon already has the sessions alive. We just need to
    // reconnect to the socket (done in init/connectToDaemon).
    // The pty-manager will call listSessions to discover what's alive.
  }

  /**
   * Disconnect from daemon without killing it.
   * Called during server shutdown — daemon and PTY processes stay alive.
   */
  detachAll(): void {
    if (this.socket) {
      try {
        this.socket.end();
      } catch {}
      this.socket = null;
    }
    this.connected = false;
    this.reconnecting = false;
  }

  /**
   * Wait for the daemon connection to be established.
   * Used by reattachSessions() to avoid querying before connected.
   */
  async ensureConnected(timeoutMs = 15000): Promise<boolean> {
    if (this.connected) return true;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 200));
      if (this.connected) return true;
    }
    return false;
  }

  /**
   * List sessions currently alive in the daemon.
   */
  async listDaemonSessions(): Promise<
    Array<{ id: string; cwd: string; shell: string; cols: number; rows: number }>
  > {
    // Wait for connection before sending — critical for startup reattach
    if (!this.connected) {
      const ok = await this.ensureConnected();
      if (!ok) {
        log.warn('Cannot list daemon sessions — not connected', {
          namespace: 'pty-backend-daemon',
        });
        return [];
      }
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingList = null;
        resolve([]);
      }, 5000);

      this.pendingList = (sessions) => {
        clearTimeout(timeout);
        resolve(sessions);
      };

      this.send({ cmd: 'list' });
    });
  }

  /**
   * Whether we're currently connected to the daemon.
   */
  get isConnected(): boolean {
    return this.connected;
  }

  // ── Private ──────────────────────────────────────────────────────

  private async connectToDaemon(): Promise<void> {
    if (this.connected || this.reconnecting) return;
    this.reconnecting = true;

    try {
      // Ensure daemon is running
      const running = await ensureDaemonRunning();
      if (!running) {
        log.error('Failed to start PTY daemon', {
          namespace: 'pty-backend-daemon',
          attempt: this.reconnectAttempts,
        });
        this.reconnecting = false;
        this.scheduleReconnect();
        return;
      }

      await this.openSocket();
      // Reset reconnect counter on successful connection
      this.reconnectAttempts = 0;
    } catch (err: any) {
      log.error('Failed to connect to PTY daemon', {
        namespace: 'pty-backend-daemon',
        error: err?.message,
        attempt: this.reconnectAttempts,
      });
      this.reconnecting = false;
      this.scheduleReconnect();
    }
  }

  private async openSocket(): Promise<void> {
    try {
      this.socket = await Bun.connect({
        unix: SOCKET_PATH,
        socket: {
          open: (_socket) => {
            this.connected = true;
            this.reconnecting = false;
            this.lineBuffer = '';
            log.info('Connected to PTY daemon', { namespace: 'pty-backend-daemon' });

            // Flush queued messages
            for (const msg of this.sendQueue) {
              try {
                _socket.write(msg);
              } catch {}
            }
            this.sendQueue = [];
          },

          data: (_socket, data) => {
            this.handleData(data.toString());
          },

          close: (_socket) => {
            this.connected = false;
            this.socket = null;
            log.warn('Disconnected from PTY daemon', { namespace: 'pty-backend-daemon' });
            this.scheduleReconnect();
          },

          error: (_socket, error) => {
            log.error('PTY daemon socket error', {
              namespace: 'pty-backend-daemon',
              error: error.message,
            });
          },
        },
      });
    } catch (err: any) {
      this.connected = false;
      this.reconnecting = false;
      throw err;
    }
  }

  private handleData(raw: string): void {
    this.lineBuffer += raw;

    let newlineIdx: number;
    while ((newlineIdx = this.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.lineBuffer.slice(0, newlineIdx).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      try {
        const msg = JSON.parse(line);
        this.handleEvent(msg);
      } catch {
        log.warn('Invalid message from PTY daemon', {
          namespace: 'pty-backend-daemon',
          line: line.slice(0, 200),
        });
      }
    }
  }

  private handleEvent(msg: any): void {
    if (!this.callbacks) return;

    switch (msg.evt) {
      case 'data':
        this.callbacks.onData(msg.id, msg.data);
        break;

      case 'exit':
        this.callbacks.onExit(msg.id, msg.exitCode ?? 0);
        break;

      case 'error':
        this.callbacks.onError(msg.id, msg.error ?? 'Unknown error');
        break;

      case 'captured': {
        const pending = this.pendingCaptures.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCaptures.delete(msg.id);
          pending.resolve(msg.state ?? null);
        }
        break;
      }

      case 'sessions':
        if (this.pendingList) {
          this.pendingList(msg.sessions ?? []);
          this.pendingList = null;
        }
        break;

      case 'spawned':
        // Session confirmed spawned — no action needed
        break;

      case 'pong':
        // Health check response — no action needed
        break;
    }
  }

  private send(msg: object): void {
    const line = JSON.stringify(msg) + '\n';

    if (this.connected && this.socket) {
      try {
        this.socket.write(line);
      } catch {
        // Queue for retry after reconnect
        this.sendQueue.push(line);
        this.scheduleReconnect();
      }
    } else {
      // Queue messages while disconnected
      this.sendQueue.push(line);
      // Reset reconnect counter — user actively wants a terminal
      if (this.reconnectAttempts > DaemonPtyBackend.MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts = 0;
      }
      // Ensure we're trying to connect
      if (!this.reconnecting) {
        this.connectToDaemon();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > DaemonPtyBackend.MAX_RECONNECT_ATTEMPTS) {
      log.error('PTY daemon reconnect limit reached, giving up', {
        namespace: 'pty-backend-daemon',
        attempts: this.reconnectAttempts,
      });
      return;
    }

    // Exponential backoff: 2s, 4s, 8s, 16s, 32s
    const delay = DaemonPtyBackend.RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1);
    log.info('Scheduling PTY daemon reconnect', {
      namespace: 'pty-backend-daemon',
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

    setTimeout(() => {
      if (!this.connected) {
        this.connectToDaemon();
      }
    }, delay);
  }
}
