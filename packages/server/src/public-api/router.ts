/**
 * The public REST API v1 procedures (openspec public-rest-api-v1). Each one
 * declares `meta.openapi` and an output schema, and calls the same port as
 * the web client's procedure, so both answer from one implementation.
 */

import { unwrap } from '@funny/api';
import type { Project } from '@funny/shared';
import {
  createThreadInput,
  createThreadOutput,
  publicModelList,
  publicProjectList,
  resolveProjectInput,
  resolveProjectOutput,
  type PublicProject,
} from '@funny/shared/contracts/public-v1';
import { z } from 'zod';

import { createProjectsPort } from '../trpc/ports/projects.js';
import { createPublicThread, listPublicModels } from './threads.js';
import { router, tokenProcedure } from './trpc.js';

/** A token is personal: its caller acts without an active organization. */
const projects = () => createProjectsPort(undefined);

function toPublicProject(project: Project): PublicProject {
  return {
    id: project.id,
    name: project.name,
    color: project.color ?? undefined,
    urls: project.urls ?? undefined,
    shared: project.isTeamProject === true,
  };
}

export const publicV1Router = router({
  listProjects: tokenProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/projects',
        protect: true,
        tags: ['projects'],
        summary: 'List your projects',
        description: 'The projects you own and the ones shared with you.',
      },
    })
    .input(z.object({}))
    .output(publicProjectList)
    .query(async ({ ctx }) => {
      const list = unwrap(await projects().list({ userId: ctx.userId, organizationId: null }, {}));
      return { projects: list.map(toPublicProject) };
    }),

  resolveProject: tokenProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/projects/resolve',
        protect: true,
        tags: ['projects'],
        summary: 'Find the project for a page',
        description: 'The first of your projects whose URL patterns match the page URL.',
      },
    })
    .input(resolveProjectInput)
    .output(resolveProjectOutput)
    .query(async ({ ctx, input }) => {
      const resolved = unwrap(await projects().resolve(ctx.userId, input.url));
      return {
        project: resolved.project ? toPublicProject(resolved.project) : null,
        source: resolved.source,
      };
    }),

  createThread: tokenProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/threads',
        protect: true,
        tags: ['threads'],
        summary: 'Create and start a thread',
        description:
          'Creates a thread in one of your projects and starts its agent on your runner. Answers 502 when your runner is not connected; it never runs on anyone else’s runner. Permission modes that act without asking are not accepted.',
      },
    })
    .input(createThreadInput)
    .output(createThreadOutput)
    .mutation(async ({ ctx, input }) => ({
      thread: unwrap(await createPublicThread(ctx.userId, ctx.runners, input)),
    })),

  listModels: tokenProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/models',
        protect: true,
        tags: ['models'],
        summary: 'List providers and models',
        description: 'The providers and models a thread can be created with, and their defaults.',
      },
    })
    .input(z.object({}))
    .output(publicModelList)
    .query(() => listPublicModels()),
});
