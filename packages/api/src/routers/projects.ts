import {
  addProjectMemberBody,
  listProjectsQuery,
  projectCommandBody,
  projectLocalPathBody,
  reorderProjectsBody,
  updateProjectBody,
} from '@funny/shared/contracts/projects';
import { z } from 'zod';

import { unwrap } from '../failure.js';
import { projectProcedure, protectedProcedure, router } from '../trpc.js';

const projectId = z.string().min(1);
const COMMANDS_FORBIDDEN = 'Only project admins can edit startup commands';

/** A startup command of the project: its id with the project id. */
const commandInput = z.object({ projectId, commandId: z.string().min(1) });

// Creation and the filesystem / git operations (branches, checkout, hooks, weave,
// config, running commands) are the runner's and stay REST.
export const projectsRouter = router({
  list: protectedProcedure
    .input(listProjectsQuery.prefault({}))
    .query(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.projects.list(
          { userId: ctx.userId, organizationId: ctx.organizationId },
          input,
        ),
      ),
    ),
  resolve: protectedProcedure
    .input(z.object({ url: z.string().min(1, 'Missing required query parameter: url') }))
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projects.resolve(ctx.userId, input.url)),
    ),
  update: projectProcedure('manage')
    .input(z.object({ projectId, data: updateProjectBody }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projects.update(ctx.userId, input.projectId, input.data)),
    ),
  remove: projectProcedure('delete')
    .input(z.object({ projectId }))
    .mutation(async ({ ctx, input }) => unwrap(await ctx.ports.projects.remove(input.projectId))),
  reorder: protectedProcedure
    .input(reorderProjectsBody)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projects.reorder(ctx.userId, input.projectIds)),
    ),
  members: projectProcedure('view')
    .input(z.object({ projectId }))
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.projects.members(input.projectId))),
  addMember: projectProcedure('manage', 'Only project admins can add members')
    .input(addProjectMemberBody.extend({ projectId }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projects.addMember(input.projectId, input.userId, input.role)),
    ),
  removeMember: projectProcedure('view')
    .input(z.object({ projectId, userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projects.removeMember(ctx.userId, input.projectId, input.userId)),
    ),
  setLocalPath: projectProcedure('view')
    .input(projectLocalPathBody.extend({ projectId }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projects.setLocalPath(ctx.userId, input.projectId, input.localPath)),
    ),
  commands: projectProcedure('view')
    .input(z.object({ projectId }))
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.projects.commands(input.projectId))),
  createCommand: projectProcedure('manage', COMMANDS_FORBIDDEN)
    .input(projectCommandBody.extend({ projectId }))
    .mutation(async ({ ctx, input: { projectId: project, ...data } }) =>
      unwrap(await ctx.ports.projects.createCommand(project, data)),
    ),
  updateCommand: projectProcedure('manage', COMMANDS_FORBIDDEN)
    .input(commandInput.extend({ data: projectCommandBody }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projects.updateCommand(input.projectId, input.commandId, input.data)),
    ),
  deleteCommand: projectProcedure('manage', COMMANDS_FORBIDDEN)
    .input(commandInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projects.deleteCommand(input.projectId, input.commandId)),
    ),
});
