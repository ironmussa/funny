/**
 * Pure creation-target normalization.
 *
 * Turns the permissive legacy creation envelope (an arbitrary JSON object) into
 * an immutable `CreationTarget` plus the payload to forward to the runtime.
 * The legacy envelope stays at this boundary. Unknown fields pass through
 * unchanged, and no stricter validation is added here.
 *
 * Invariants:
 *  - Only `isScratch === true` marks a scratch request.
 *  - A scratch target has no project and always runs in `local` mode.
 *  - A project target carries a truthy project reference.
 *  - Evaluation order: scratch+project → scratch+non-local mode → missing project.
 */

import type { JsonValue } from '@bufbuild/protobuf';
import { err, ok, type Result } from 'neverthrow';

/**
 * The legacy creation envelope: a JSON object, as the client's request body
 * carried it or as a server caller (automation, issue factory, public API)
 * built it. It is forwarded to the runtime as JSON, where a field set to
 * `undefined` is left out.
 */
export type CreationPayload = { readonly [field: string]: JsonValue | undefined };

export type CreationTarget =
  | Readonly<{ kind: 'scratch'; mode: 'local' }>
  | Readonly<{
      kind: 'project';
      /**
       * Project reference exactly as the client sent it. Only truthiness is
       * checked, which is the legacy contract. Resolution and the runtime own
       * any further validation.
       */
      projectId: string;
    }>;

export type CreationRejectionCode =
  | 'scratch-thread-cannot-have-project'
  | 'scratch-thread-must-be-local'
  | 'project-required';

export interface CreationRejection {
  readonly code: CreationRejectionCode;
  readonly message: string;
}

export interface NormalizedCreation {
  readonly target: CreationTarget;
  /** Payload forwarded to the runtime (normalized for scratch, otherwise untouched). */
  readonly payload: CreationPayload;
}

const SCRATCH_TARGET: CreationTarget = Object.freeze({ kind: 'scratch', mode: 'local' });

export function normalizeCreationRequest(
  raw: CreationPayload,
): Result<NormalizedCreation, CreationRejection> {
  if (raw.isScratch === true) {
    if (raw.projectId != null) {
      return err({
        code: 'scratch-thread-cannot-have-project',
        message: 'Scratch threads cannot have a project',
      });
    }
    if (raw.mode && raw.mode !== 'local') {
      return err({
        code: 'scratch-thread-must-be-local',
        message: 'Scratch threads must use mode = local',
      });
    }
    return ok({
      target: SCRATCH_TARGET,
      payload: Object.freeze({ ...raw, projectId: null, mode: 'local', isScratch: true }),
    });
  }

  if (!raw.projectId) {
    return err({ code: 'project-required', message: 'projectId is required' });
  }
  return ok({
    // SAFETY: projectId is truthy here, and every caller (web client, automations,
    // factory, public API) sends it as a project id string.
    target: Object.freeze({ kind: 'project', projectId: raw.projectId as string }),
    payload: raw,
  });
}

/** Project reference stored in the registry (null for scratch). */
export function targetProjectId(target: CreationTarget): string | null {
  return target.kind === 'project' ? target.projectId : null;
}
