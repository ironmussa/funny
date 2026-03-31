/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: port
 * @domain layer: application
 *
 * PTY backend interface — abstracts the underlying PTY implementation
 * so the manager can swap between Bun native, node-pty, or a null fallback.
 */

export interface PtyBackendCallbacks {
  onData: (ptyId: string, data: string) => void;
  onExit: (ptyId: string, exitCode: number) => void;
  onError: (ptyId: string, error: string) => void;
}

export interface PtyBackend {
  readonly name: string;
  readonly available: boolean;

  /** Whether this backend supports session persistence across server restarts. */
  readonly persistent?: boolean;

  init(callbacks: PtyBackendCallbacks): void;

  spawn(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    env: Record<string, string | undefined>,
    shell?: string,
  ): void;

  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  killAll(): void;

  /**
   * Reattach to an existing session that survived a server restart.
   * For tmux: reattaches to the tmux session.
   * For headless-xterm: restores serialized terminal state and spawns a fresh PTY.
   */
  reattach?(
    id: string,
    tmuxSession: string,
    cols: number,
    rows: number,
    restoredState?: string,
    cwd?: string,
    shell?: string,
  ): void;

  /**
   * Detach all attach processes without killing the underlying sessions.
   * Called during shutdown for persistent backends so sessions survive restart.
   */
  detachAll?(): void;

  /**
   * Capture the current visible pane content (scrollback + visible area).
   * Only implemented by persistent backends (e.g. tmux).
   * Returns the captured content with ANSI escape sequences preserved.
   */
  capturePane?(id: string): string | null;

  /**
   * Send a signal to a PTY process without killing the session.
   * Used for SIGINT (2), SIGTERM (15), SIGKILL (9).
   */
  signal?(id: string, signal: number): void;
}
