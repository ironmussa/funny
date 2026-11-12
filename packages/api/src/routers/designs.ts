import { createDesignBody } from '@funny/shared/contracts/designs';
import { z } from 'zod';

import { unwrap } from '../failure.js';
import { projectProcedure, resourceProcedure, router } from '../trpc.js';
import { byId } from './by-id.js';

const projectId = z.string().min(1);

/** A design is the owner's only: 404 / 403 before anything else. */
const ownDesign = resourceProcedure((ports, userId, id) =>
  ports.designs.authorizeAccess(userId, id),
);

// The design folder on disk (create / delete directory) is the runner's and stays REST.
export const designsRouter = router({
  list: projectProcedure('view')
    .input(z.object({ projectId }))
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.designs.list(ctx.userId, input.projectId)),
    ),
  create: projectProcedure('view')
    .input(createDesignBody.extend({ projectId }))
    .mutation(async ({ ctx, input: { projectId: project, ...data } }) =>
      unwrap(await ctx.ports.designs.create(ctx.userId, project, data)),
    ),
  get: ownDesign
    .input(byId)
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.designs.get(ctx.userId, input.id))),
  remove: ownDesign
    .input(byId)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.designs.remove(ctx.userId, input.id)),
    ),
});
