/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * A member's controls over a run's spec (openspec factory-spec-stage), split
 * out of `factory-run-control.ts`: approve the draft shown, reopen an approved
 * spec. Only the board (a member's browser session, through the `factory`
 * tRPC group) reaches them; no factory MCP tool and nothing on the runner's
 * data channel does.
 */

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import type { FactoryRunControlError } from './factory-run-control.js';
import type { createFactoryRunsRepository, FactoryRunView } from './factory-runs.js';
import { getWatchedFactory } from './factory-settings.js';
import { releaseSpecWorkspace, reviseSpec } from './factory-spec.js';

/**
 * Free the spec writer's checkout of a run that left `needs_spec` (approved,
 * retriaged, held, stopped). The thread belongs to the factory's enabler.
 */
export async function releaseSpecOf(run: FactoryRunView): Promise<void> {
  if (!run.spec?.threadId) return;
  const factory = await getWatchedFactory(run.factoryId);
  if (factory) await releaseSpecWorkspace(run, factory.userId);
}

/** Why a spec approval was refused, as the member reads it. */
const SPEC_APPROVAL_REFUSED = {
  'not-waiting-for-spec': 'The run no longer waits for its spec. Reload to see where it is.',
  'revision-moved': 'The spec writer stored a newer draft. Reload and review it.',
  'no-draft': 'The spec has no draft to approve yet.',
} as const;

const storage = (error: { message: string }): FactoryRunControlError => ({
  kind: 'storage',
  message: error.message,
});

interface SpecControlDeps {
  runs: ReturnType<typeof createFactoryRunsRepository>;
  /** The run, when it belongs to the factory. */
  runOf(factoryId: string, runId: string): ResultAsync<FactoryRunView, FactoryRunControlError>;
  /** The run as it is now (after a change). */
  reread(runId: string): ResultAsync<FactoryRunView, FactoryRunControlError>;
  /** Look at the factory now. */
  wake(factoryId: string): void;
}

export function createSpecControls({ runs, runOf, reread, wake }: SpecControlDeps) {
  return {
    /**
     * A member approves the spec draft of `revision` (openspec
     * factory-spec-stage), from their browser session only: the run goes back
     * to the queue at its earlier place with the draft's contract. Refused
     * (conflict) when the run left `needs_spec` or a newer draft was stored.
     */
    approveSpec(
      userId: string,
      factoryId: string,
      runId: string,
      revision: number,
    ): ResultAsync<FactoryRunView, FactoryRunControlError> {
      return runOf(factoryId, runId)
        .andThen((run) =>
          runs
            .approveSpec(run.id, revision, userId)
            .mapErr(storage)
            .andThen((outcome) =>
              outcome.approved
                ? ResultAsync.fromSafePromise(releaseSpecOf(run))
                : errAsync<undefined, FactoryRunControlError>({
                    kind: 'conflict',
                    message: SPEC_APPROVAL_REFUSED[outcome.reason],
                  }),
            ),
        )
        .andThen(() => {
          wake(factoryId);
          return reread(runId);
        });
    },

    /**
     * A member reopens the run's spec: one waiting in the queue with an
     * approved spec, or one that parked after it ran. The approval is dropped,
     * the run waits in `needs_spec`, and the spec writer's thread is asked for
     * a revision (a new spec writer when it cannot be). A run in flight is
     * stopped first.
     */
    reopenSpec(
      factoryId: string,
      runId: string,
    ): ResultAsync<FactoryRunView, FactoryRunControlError> {
      return runOf(factoryId, runId)
        .andThen((run) =>
          runs
            .reopenSpec(run.id)
            .mapErr(storage)
            .andThen((written) =>
              written
                ? okAsync(run.spec?.approved?.spec ?? null)
                : errAsync<null, FactoryRunControlError>({
                    kind: 'conflict',
                    message:
                      'Only a run waiting in the queue, or one that parked or ended without merging, can have its spec reopened. Stop a running one first.',
                  }),
            ),
        )
        .andThen((previous) =>
          reread(runId).andThen((run) =>
            ResultAsync.fromSafePromise(reviseSpec(run, previous)).map((revised) => {
              if (revised.isErr()) {
                log.warn('Issue factory could not ask for a spec revision', {
                  namespace: 'factory',
                  runId,
                  error: revised.error,
                });
              }
            }),
          ),
        )
        .andThen(() => reread(runId));
    },
  };
}
