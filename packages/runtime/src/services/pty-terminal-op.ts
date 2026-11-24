import { log } from '../lib/logger.js';

/**
 * Run an operation on a live PTY session's terminal (write, resize). A throw is logged
 * under the backend's namespace and swallowed, so one bad terminal never takes the
 * backend down.
 */
export function runPtyTerminalOp(
  op: () => void,
  failure: { message: string; namespace: string; ptyId: string },
): void {
  try {
    op();
  } catch (err: any) {
    log.error(failure.message, {
      namespace: failure.namespace,
      ptyId: failure.ptyId,
      error: err?.message,
    });
  }
}
