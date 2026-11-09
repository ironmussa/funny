/**
 * Production wiring of the reverse runner link (change thread-sandboxes): the
 * supervisor over the sandbox table, dialers into the server's reverse-link
 * listener, and the periodic pass as an Effect fiber that `stop` interrupts.
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { Effect, Fiber, Schedule } from 'effect';
import { ResultAsync } from 'neverthrow';

import { db } from '../../../db/index.js';
import { threadSandboxes } from '../../../db/schema.js';
import { deriveServerKey } from '../../../lib/auth.js';
import { log } from '../../../lib/logger.js';
import type { InfraConnectionService } from '../infra-connections.js';
import { reverseLinkSecret } from '../runner-link.js';
import { startReverseLinkDialer } from './dialer.js';
import {
  createReverseLinkSupervisor,
  REVERSE_LINK_STATES,
  type ReverseLinkedSandbox,
} from './supervisor.js';

/** Short: a runner waits for a spare only `waitForSpareMs` (30 s) on connect. */
const PASS_INTERVAL_MS = 3_000;

export interface ReverseLinks {
  stop(): Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function listLinked(): ResultAsync<ReverseLinkedSandbox[], string> {
  return ResultAsync.fromPromise(
    db
      .select({
        threadId: threadSandboxes.threadId,
        generation: threadSandboxes.generation,
        userId: threadSandboxes.userId,
        connectionId: threadSandboxes.connectionId,
        sandboxId: threadSandboxes.sandboxId,
      })
      .from(threadSandboxes)
      .where(
        and(
          eq(threadSandboxes.runnerLink, 'reverse'),
          inArray(threadSandboxes.state, [...REVERSE_LINK_STATES]),
          isNotNull(threadSandboxes.sandboxId),
        ),
      ),
    message,
  ).map((rows) => rows.map((row) => ({ ...row, sandboxId: row.sandboxId! })));
}

export function startReverseLinks(deps: {
  connections: Pick<InfraConnectionService, 'providerFor'>;
  target: { hostname: string; port: number };
}): ReverseLinks {
  const key = deriveServerKey('reverse-link');
  const supervisor = createReverseLinkSupervisor({
    listLinked,
    providerFor: (sandbox) =>
      deps.connections
        .providerFor(sandbox.userId, sandbox.connectionId)
        .map(({ provider }) => provider)
        .mapErr((e) => e.message),
    secretFor: (sandbox) => reverseLinkSecret(key, sandbox.threadId, sandbox.generation),
    startDialer: ({ sandbox, ingress, secret, onUnhealthy }) =>
      startReverseLinkDialer({
        ingress,
        secret,
        target: deps.target,
        onUnhealthy,
        label: sandbox.threadId,
      }),
  });

  const pass = Effect.promise(async () => {
    const report = await supervisor.sync();
    if (report.started > 0 || report.stopped > 0) {
      log.info('Reverse link pass', { namespace: 'reverse-link', ...report });
    }
  });
  const fiber = Effect.runFork(
    Effect.repeat(
      Effect.catchCause(pass, (cause) =>
        Effect.sync(() =>
          log.error('Reverse link pass failed', {
            namespace: 'reverse-link',
            error: String(cause),
          }),
        ),
      ),
      Schedule.spaced(PASS_INTERVAL_MS),
    ),
  );

  return {
    async stop() {
      await Effect.runPromise(Fiber.interrupt(fiber));
      supervisor.close();
    },
  };
}
