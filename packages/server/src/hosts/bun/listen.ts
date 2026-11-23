/**
 * The central server's HTTP listener binds its port EXCLUSIVELY.
 *
 * The server keeps per-process state that assumes it is the only instance:
 * the automation cron (`services/automation-scheduler.ts`), the issue factory
 * watcher, the sandbox lifecycle, Socket.IO sessions and runner presence. With
 * `reusePort: true` a second process on the same port binds without an error,
 * the kernel splits connections between the two, and each runs its own cron,
 * so every automation fires twice. Without it the second process fails with
 * `EADDRINUSE` before it starts any background job.
 */

import { log } from '../../lib/logger.js';

type ServeOptions = Parameters<typeof Bun.serve>[0];

export function serveExclusive<T>(options: ServeOptions & { port: number }): Bun.Server<T> {
  try {
    return Bun.serve<T>({ ...(options as any), reusePort: false });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'EADDRINUSE') {
      log.error(
        `Port ${options.port} is already in use. Another funny-server may be running; the server runs as a single instance (the automation scheduler assumes one).`,
        { namespace: 'server', port: options.port },
      );
    }
    throw error;
  }
}
