/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Null PTY backend — used when no PTY implementation is available.
 * Every spawn() call immediately fires onError with a descriptive message.
 */

import { log } from '../lib/logger.js';
import type { PtyBackend, PtyBackendCallbacks } from './pty-backend.js';

export class NullPtyBackend implements PtyBackend {
  readonly name = 'null';
  readonly available = true; // Always "available" as a last-resort fallback

  private callbacks: PtyBackendCallbacks | null = null;

  init(callbacks: PtyBackendCallbacks): void {
    this.callbacks = callbacks;
  }

  spawn(id: string): void {
    log.warn('No PTY backend available, terminal cannot be started', {
      namespace: 'pty-null',
      ptyId: id,
    });
    this.callbacks?.onError(
      id,
      'Terminal is not available: no PTY backend found. ' +
        'Ensure Bun >= 1.3.5 (Linux/macOS) or node-pty is installed (Windows).',
    );
  }

  write(): void {}
  resize(): void {}
  kill(): void {}
  killAll(): void {}
}
