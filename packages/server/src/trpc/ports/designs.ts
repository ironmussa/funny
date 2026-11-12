/**
 * Design rows, for both the REST routes (`/api/projects/:id/designs`,
 * `/api/designs/:id`) and the `designs` tRPC router. The folder on disk is
 * created and removed by the runtime; only the row lives here.
 */

import { failure, type DesignsPort } from '@funny/api';
import { nanoid } from 'nanoid';
import { err, ok } from 'neverthrow';

import { repos } from '../../db/repos.js';

const designRepo = repos.designs();

export const designsPort: DesignsPort = {
  async list(userId, projectId) {
    return ok(await designRepo.listDesigns(projectId, userId));
  },

  async create(userId, projectId, data) {
    const id = nanoid();
    return ok(
      await designRepo.createDesign({
        id,
        projectId,
        userId,
        name: data.name,
        type: data.type,
        fidelity: data.fidelity ?? null,
        speakerNotes: !!data.speakerNotes,
        folderPath: `designs/${id}`,
      }),
    );
  },

  async get(_userId, id) {
    const design = await designRepo.getDesign(id);
    return design ? ok(design) : err(failure(404, 'Design not found'));
  },

  async remove(_userId, id) {
    await designRepo.deleteDesign(id);
    return ok({ ok: true as const });
  },

  async authorizeAccess(userId, id) {
    const design = await designRepo.getDesign(id);
    if (!design) return failure(404, 'Design not found');
    return design.userId === userId ? null : failure(403, 'Access denied');
  },
};
