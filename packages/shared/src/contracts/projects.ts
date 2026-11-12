/**
 * Input schemas and responses of the project routes the server answers itself
 * (served over tRPC, `@funny/api` `projects` router, and by the REST routes).
 * Creation and the filesystem / git operations (branches, checkout, hooks,
 * weave, config, running commands) are the runner's and stay REST.
 */

import { z } from 'zod';

import type { Project } from '../types.js';

export const listProjectsQuery = z.object({
  /** Name / path search. */
  q: z.string().optional(),
  /** Only the caller's personal projects (no organization). */
  personal: z.boolean().optional(),
  /** An organization the caller belongs to; defaults to the session's active one. */
  orgId: z.string().optional(),
});

export const updateProjectBody = z.object({
  name: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  color: z.string().nullable().optional(),
  followUpMode: z.string().optional(),
  defaultProvider: z.string().nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  defaultEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  defaultMode: z.string().nullable().optional(),
  defaultPermissionMode: z.string().nullable().optional(),
  defaultBranch: z.string().nullable().optional(),
  urls: z.array(z.string()).nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  launcherUrl: z.string().nullable().optional(),
  defaultAgentTemplateId: z.string().nullable().optional(),
  closed: z.boolean().optional(),
  fastMode: z.boolean().optional(),
  redirectChecks: z.boolean().optional(),
});

export const reorderProjectsBody = z.object({
  projectIds: z.array(z.string().min(1)).min(1, 'projectIds must be a non-empty array'),
});

export const addProjectMemberBody = z.object({
  userId: z.string().min(1, 'Missing required field: userId'),
  role: z.string().optional(),
});

export const projectLocalPathBody = z.object({
  localPath: z.string().min(1, 'Missing required field: localPath'),
});

export const projectCommandBody = z.object({
  label: z.string().min(1, 'label and command are required'),
  command: z.string().min(1, 'label and command are required'),
  port: z.number().optional(),
  portEnvVar: z.string().optional(),
});

export type ListProjectsQuery = z.output<typeof listProjectsQuery>;
export type UpdateProjectBody = z.output<typeof updateProjectBody>;
export type ProjectCommandBody = z.output<typeof projectCommandBody>;

/** A project collaborator with the user's display fields. */
export interface ProjectMemberEntry {
  projectId: string;
  userId: string;
  role: string;
  localPath: string | null;
  joinedAt: string;
  user: { name: string; username: string | null; email: string } | null;
}

export interface ResolveProjectResponse {
  project: Project | null;
  source: 'url_match' | 'none';
}
