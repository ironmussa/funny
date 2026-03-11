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
   * Only implemented by persistent backends (e.g. tmux).
   */
  reattach?(id: string, tmuxSession: string, cols: number, rows: number): void;

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
}
