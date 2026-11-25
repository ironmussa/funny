/**
 * Pipeline CRUD and run history on the server's DB, for both `/api/pipelines`
 * (REST) and the `pipelines` tRPC router. Pipeline execution (review/fix runs)
 * stays on the runner; approval gates stay REST.
 */

import { failure, type PipelinesPort } from '@funny/api';
import type { UpdatePipelineRequest } from '@funny/shared/contracts/pipelines';
import { err, ok } from 'neverthrow';

import { toPipeline, toPipelineRun } from '../../lib/pipeline-response.js';
import * as pipelineRepo from '../../services/pipeline-repository.js';
import { definedFields } from './defined-fields.js';
import { requireVisibleProject } from './project-gate.js';

/** Column writes for a PATCH body: flags become integers, empty prompts become null. */
function pipelineUpdates(body: UpdatePipelineRequest): pipelineRepo.PipelineUpdate {
  const {
    enabled,
    precommitFixEnabled,
    testEnabled,
    testFixEnabled,
    reviewerPrompt,
    correctorPrompt,
    precommitFixerPrompt,
    commitMessagePrompt,
    testCommand,
    testFixerPrompt,
    ...plain
  } = body;
  const updates: pipelineRepo.PipelineUpdate = definedFields(plain);
  const flags = { enabled, precommitFixEnabled, testEnabled, testFixEnabled };
  for (const column of FLAG_COLUMNS) {
    const value = flags[column];
    if (value !== undefined) updates[column] = value ? 1 : 0;
  }
  const texts = {
    reviewerPrompt,
    correctorPrompt,
    precommitFixerPrompt,
    commitMessagePrompt,
    testCommand,
    testFixerPrompt,
  };
  for (const column of NULLABLE_TEXT_COLUMNS) {
    const value = texts[column];
    if (value !== undefined) updates[column] = value || null;
  }
  return updates;
}

const FLAG_COLUMNS = ['enabled', 'precommitFixEnabled', 'testEnabled', 'testFixEnabled'] as const;
const NULLABLE_TEXT_COLUMNS = [
  'reviewerPrompt',
  'correctorPrompt',
  'precommitFixerPrompt',
  'commitMessagePrompt',
  'testCommand',
  'testFixerPrompt',
] as const;

const notFound = () => err(failure(404, 'Pipeline not found'));

export const pipelinesPort: PipelinesPort = {
  async list(userId, projectId) {
    // Security CR-5: scope to caller's pipelines so cross-tenant rows are
    // filtered server-side rather than relying on the project belonging to
    // the user (project ownership is enforced separately).
    const rows = await pipelineRepo.getPipelinesByProject(projectId, userId);
    return ok(rows.map(toPipeline));
  },

  async get(userId, id) {
    const pipeline = await pipelineRepo.getPipelineById(id, userId);
    return pipeline ? ok(toPipeline(pipeline)) : notFound();
  },

  async create(userId, data) {
    // The pipeline reviews this project's threads.
    const visible = await requireVisibleProject(userId, data.projectId);
    if (visible.isErr()) return err(visible.error);
    const id = await pipelineRepo.createPipeline({ ...data, userId });
    const pipeline = await pipelineRepo.getPipelineById(id, userId);
    return pipeline ? ok(toPipeline(pipeline)) : err(failure(500, 'Pipeline was not saved'));
  },

  async update(userId, id, data) {
    if (!(await pipelineRepo.getPipelineById(id, userId))) return notFound();
    await pipelineRepo.updatePipeline(id, userId, pipelineUpdates(data));
    const updated = await pipelineRepo.getPipelineById(id, userId);
    return updated ? ok(toPipeline(updated)) : notFound();
  },

  async remove(userId, id) {
    if (!(await pipelineRepo.getPipelineById(id, userId))) return notFound();
    await pipelineRepo.deletePipeline(id, userId);
    return ok({ ok: true as const });
  },

  async runsForThread(userId, threadId) {
    // Security CR-5: getRunsForThread verifies thread ownership internally and
    // returns [] for cross-tenant lookups.
    const runs = await pipelineRepo.getRunsForThread(threadId, userId);
    return ok(runs.map(toPipelineRun));
  },
};
