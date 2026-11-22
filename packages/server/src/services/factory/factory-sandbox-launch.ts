/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Starting a factory run's agent thread in the enabler's SANDBOX (the issue
 * factory's "flow runs as the enabler on their runtime" requirement): the
 * same sandbox thread launcher as `POST /api/threads` with `runtime:
 * 'sandbox'` (`thread-sandboxes`), on the enabler's own sandbox connection
 * for the project. The thread is created at once (`setting_up`) and its
 * agent starts once the sandbox is ready; the factory's step waits on the
 * thread's persisted status like any other. A refusal (no sandbox configured,
 * no public URL, …) is the step's error, shown with the launcher's message.
 */

import { err, ok, type Result } from 'neverthrow';

import type { RunnerPorts, StartedThread, StartThreadError } from '../runner-thread-launcher.js';
import { sandboxThreadLauncherFor } from '../thread-sandboxes/sandbox-thread-wiring.js';
import type { BrowserEventsPort } from './factory-thread-requests.js';

export function factorySandboxLauncher(ports: RunnerPorts, browserEvents?: BrowserEventsPort) {
  return async (
    userId: string,
    body: Record<string, unknown>,
  ): Promise<Result<StartedThread, StartThreadError>> => {
    const launcher = sandboxThreadLauncherFor({
      runnerRequests: ports.requests,
      runnerPresence: ports.presence,
      browserEvents,
    });
    const created = await launcher.create(userId, body);
    if (created.isErr()) {
      return err({
        kind: 'runner-error',
        status: created.error.status,
        message: created.error.message,
      });
    }
    const thread = created.value.thread as { id?: string } | null;
    return ok({ thread, threadId: thread?.id, runnerId: 'sandbox' });
  };
}
