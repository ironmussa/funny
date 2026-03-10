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
}
