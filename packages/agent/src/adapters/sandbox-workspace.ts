/**
 * Sandbox workspaces (#289), the default workspace kind, on `@funny/sandbox`.
 *
 * - Template: the funny runner template of the factory's own commit (the
 *   template manager builds it on demand). It holds the whole funny checkout
 *   at `/opt/funny`, the step runner included; the factory never writes the
 *   runner's env file, so funny's runner never starts in it.
 * - Secrets: the model credential and the run's App token are written through
 *   `exec` to root-only files, never through the create request, whose env
 *   stays empty. git and `gh` read the token from there on every call, so a
 *   renewal applies at once.
 * - Repository: cloned inside the sandbox with the run's token; every git and
 *   GitHub step of the run happens there.
 * - Steps: started detached and polled (`sandbox-step.ts`).
 * - No fallback: a sandbox that cannot be created or used fails the step as an
 *   infrastructure failure; no worktree is ever made instead.
 */

import { existsSync } from 'fs';
import { rm } from 'fs/promises';

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { stepOutcomeSchema } from '../domain/step-outcome.js';
import type { WorkspaceProvider, WorkspaceRequest } from '../ports/workspaces.js';
import { createSandboxPause } from './sandbox-pause.js';
import {
  createSandboxSession,
  q,
  type SandboxRecord,
  type SandboxWorkspaceDeps,
} from './sandbox-session.js';
import { sandboxRunWorkspace } from './sandbox-step.js';

export type { SandboxLayout, SandboxWorkspaceDeps } from './sandbox-session.js';

export function createSandboxWorkspaces(deps: SandboxWorkspaceDeps): WorkspaceProvider {
  const session = createSandboxSession(deps);
  const { provider, recordPath, paths, writeToken, setUp, clone, boot, save, load } = session;
  const failure = (e: { kind: string; message: string }) => `${e.kind}: ${e.message}`;
  const pausing = createSandboxPause(session, deps);
  const workspace = (record: SandboxRecord, request: WorkspaceRequest, expiry: number) =>
    sandboxRunWorkspace(session, deps, record, request, expiry, () =>
      pausing.pause(record, request),
    );

  /** Destroy a sandbox, best effort (a leak is logged). */
  const destroy = (record: SandboxRecord) =>
    provider.destroy(record.handle).orElse((e) => {
      deps.log.warn('Could not destroy a sandbox', {
        sandbox: record.handle.sandboxId,
        error: failure(e),
      });
      return okAsync(undefined);
    });

  /**
   * A new sandbox with the repository cloned: from the base, or from the run's
   * pushed branch. A sandbox that could not be set up is destroyed at once.
   */
  const createIn = (request: WorkspaceRequest, fromBranch: boolean) =>
    boot(request)
      .andThen((record) => save(request, record))
      .andThen((record) =>
        setUp(record, request)
          .andThen((expiry) =>
            clone(record, request, fromBranch)
              .andThen(() =>
                fromBranch
                  ? ResultAsync.fromSafePromise(pausing.restoreSessions(record, request))
                  : okAsync(undefined),
              )
              .map(() => workspace(record, request, expiry)),
          )
          .orElse((error) => destroy(record).andThen(() => errAsync(error))),
      );

  /** The recorded sandbox, if the provider still has it; null when it is gone. */
  const recorded = (request: WorkspaceRequest) =>
    load(request)
      .map((record): SandboxRecord | null => record)
      .orElse(() => okAsync<SandboxRecord | null, string>(null))
      .andThen((record) =>
        !record
          ? okAsync(null)
          : provider
              .status(record.handle)
              .map((status) =>
                ['failed', 'lost'].includes(status.state) ? null : { record, status },
              )
              .orElse((e) => (e.kind === 'not-found' ? okAsync(null) : errAsync(failure(e)))),
      );

  /** An existing sandbox, running, with the run's checkout in it (cloned again if it is not). */
  const resumeIn = (request: WorkspaceRequest, record: SandboxRecord, stopped: boolean) => {
    const repo = paths(record, request.runId).repo;
    return (stopped ? provider.resume(record.handle).mapErr(failure) : okAsync(undefined))
      .andThen(() => writeToken(record, request))
      .andThen((expiry) =>
        provider
          .exec(record.handle, `test -d ${q(`${repo}/.git`)}`)
          .mapErr(failure)
          .andThen((check) => (check.exitCode === 0 ? okAsync('') : clone(record, request, true)))
          .map(() => workspace(record, request, expiry)),
      );
  };

  return {
    prepare(request) {
      // A retry starts over: a sandbox an earlier attempt left (paused) goes first.
      return load(request)
        .andThen((old) => destroy(old))
        .orElse(() => okAsync(undefined))
        .andThen(() => ResultAsync.fromSafePromise(pausing.clear(request)))
        .andThen(() => createIn(request, false));
    },

    reopen(request) {
      return recorded(request).andThen((found) => {
        if (found) return resumeIn(request, found.record, found.status.state === 'stopped');
        // Gone (or never made): a new sandbox from the pushed branch, the old one destroyed.
        return load(request)
          .andThen((old) => destroy(old))
          .orElse(() => okAsync(undefined))
          .andThen(() => createIn(request, true));
      });
    },

    remove(request) {
      return ResultAsync.fromSafePromise(pausing.clear(request))
        .andThen(() => load(request))
        .andThen((record) => provider.destroy(record.handle).mapErr(failure))
        .orElse((error) =>
          error === 'the run has no sandbox' ? okAsync(undefined) : errAsync(error),
        )
        .andThen(() =>
          ResultAsync.fromPromise(rm(recordPath(request), { force: true }), (error) =>
            String(error),
          ),
        );
    },

    discard(request) {
      return ResultAsync.fromSafePromise(pausing.clear(request))
        .andThen(() => load(request))
        .andThen((record) => destroy(record))
        .orElse(() => okAsync(undefined))
        .andThen(() => ResultAsync.fromPromise(rm(recordPath(request), { force: true }), String));
    },

    exists(request) {
      // A sandbox destroyed on purpose while CI runs counts as there: it is made again.
      return existsSync(recordPath(request)) || pausing.paused(request);
    },

    async stopLeftovers(request) {
      const record = await load(request);
      if (record.isErr()) return;
      const p = paths(record.value, request.runId);
      await provider.exec(
        record.value.handle,
        `[ -f ${q(p.pid)} ] && kill "$(cat ${q(p.pid)})" 2>/dev/null; rm -f ${q(p.pid)}; true`,
      );
    },

    async lastSessionId(request) {
      const record = await load(request);
      if (record.isErr()) return undefined;
      const read = await provider.exec(
        record.value.handle,
        `cat ${q(paths(record.value, request.runId).exitMarker)} 2>/dev/null || true`,
      );
      if (read.isErr()) return undefined;
      try {
        const marker = stepOutcomeSchema.safeParse(JSON.parse(read.value.stdout));
        return marker.success ? marker.data.sessionId : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
