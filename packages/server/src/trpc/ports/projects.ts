/**
 * The project operations the server answers itself, for both `/api/projects`
 * (REST) and the `projects` tRPC router. Project access is checked before these
 * run (`requireProjectAccess` / `projectProcedure`); creation and the filesystem
 * / git operations are the runner's and stay in routes/projects.ts.
 *
 * Built per request: the listing names the session's active organization.
 */

import { isAbsolute, resolve } from 'path';

import { failure, type ProjectCommand, type ProjectsPort } from '@funny/api';
import type { Project } from '@funny/shared';
import { includesSearchText } from '@funny/shared/lib/text-search';
import { err, ok } from 'neverthrow';

import { authorizer } from '../../lib/server-authorizer.js';
import * as pm from '../../services/project-manager.js';
import * as projectRepo from '../../services/project-repository.js';
import * as cmdRepo from '../../services/startup-commands-repository.js';

/** Roles a project admin may assign to a collaborator (owner = creator only). */
const ASSIGNABLE_PROJECT_ROLES = new Set(['viewer', 'member', 'admin']);

/**
 * Fields that steer the OWNER's agents on the OWNER's runner (working directory,
 * system prompt, default permission mode). A project admin can manage shared
 * settings but must not be able to redirect or loosen the owner's agents.
 */
const OWNER_ONLY_PROJECT_FIELDS = ['path', 'systemPrompt', 'defaultPermissionMode'] as const;

const ok200 = () => ok({ ok: true as const });

type CommandRow = Awaited<ReturnType<typeof cmdRepo.listCommands>>[number];

function toStartupCommand(row: CommandRow): ProjectCommand {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    command: row.command,
    port: row.port ?? undefined,
    portEnvVar: row.portEnvVar ?? undefined,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
  };
}

/** The status a project repository error answers. */
function repoFailure(e: { type: string; message: string }) {
  const status = { CONFLICT: 409, NOT_FOUND: 404, BAD_REQUEST: 400 }[e.type] ?? 500;
  return err(failure(status, e.message));
}

async function listOrgProjects(
  userId: string,
  orgId: string,
  organizationName: string | undefined,
): Promise<Project[]> {
  const teamProjects = await projectRepo.listProjectsByOrg(orgId);
  const sharedProjects = teamProjects.filter((p) => p.userId !== userId);
  const localPaths = await Promise.all(
    sharedProjects.map((p) => projectRepo.getMemberLocalPath(p.id, userId)),
  );
  const localPathByProject = new Map(sharedProjects.map((p, i) => [p.id, localPaths[i]]));

  return teamProjects.map((p) => {
    if (p.userId === userId) {
      return { ...p, isTeamProject: true as const, organizationName, role: 'owner' as const };
    }
    const lp = localPathByProject.get(p.id) ?? null;
    return {
      ...p,
      isTeamProject: true as const,
      organizationName,
      localPath: lp ?? undefined,
      needsSetup: !lp,
    };
  });
}

async function listPersonalProjects(userId: string): Promise<Project[]> {
  const projects = await projectRepo.listProjects(userId);
  // Exclude projects that belong to any organization
  const orgProjectIds = await projectRepo.getOrgProjectIds();
  const personalProjects = (
    orgProjectIds.length > 0 ? projects.filter((p) => !orgProjectIds.includes(p.id)) : projects
  ).map((p) => ({ ...p, role: 'owner' as const }));

  // Collaborator model: also surface projects the user was added to directly
  // (project_members) but does not own. Each carries the member's own local
  // working path and role; `needsSetup` flags those that still require the
  // member to pick a local directory (and connect their own runner) before use.
  const ownedIds = new Set(personalProjects.map((p) => p.id));
  const memberProjects = await projectRepo.listMemberProjects(userId);
  const sharedProjects = memberProjects
    .filter((p) => p.userId !== userId && !ownedIds.has(p.id))
    .map(({ localPath, memberRole, ...p }) => ({
      ...p,
      isTeamProject: true as const,
      localPath: localPath ?? undefined,
      needsSetup: !localPath,
      role: (memberRole === 'admin' ? 'admin' : 'member') as 'admin' | 'member',
    }));
  return [...personalProjects, ...sharedProjects];
}

export function createProjectsPort(organizationName: string | null | undefined): ProjectsPort {
  return {
    async list({ userId, organizationId }, query) {
      const search = query.q?.trim();
      const orgId = query.personal ? null : query.orgId || organizationId;
      if (orgId) {
        // Security M2: `orgId` is caller-supplied — only list an org's projects
        // to its members (the session's active org is re-checked too, so a stale
        // active org after removal does not keep exposing the listing).
        if ((await authorizer.effectiveRole(userId, 'org', orgId)) === null) {
          return err(failure(403, 'Not a member of this organization'));
        }
      }
      const projects = orgId
        ? await listOrgProjects(userId, orgId, organizationName || undefined)
        : await listPersonalProjects(userId);
      return ok(
        search
          ? projects.filter(
              (p) => includesSearchText(p.name, search) || includesSearchText(p.path, search),
            )
          : projects,
      );
    },

    async resolve(userId, url) {
      const projects = await projectRepo.listProjects(userId);
      const matched = projects.find((p) => p.urls?.some((pattern) => url.startsWith(pattern)));
      return ok(
        matched
          ? { project: matched, source: 'url_match' as const }
          : { project: null, source: 'none' as const },
      );
    },

    async update(userId, projectId, data) {
      // Security M6: owner-only fields.
      const ownerOnly = OWNER_ONLY_PROJECT_FIELDS.filter((f) => data[f] !== undefined);
      if (
        ownerOnly.length > 0 &&
        (await authorizer.effectiveRole(userId, 'project', projectId)) !== 'owner'
      ) {
        return err({
          ...failure(403, `Only the project owner can change: ${ownerOnly.join(', ')}`),
          code: 'project-owner-only-field',
        });
      }
      const result = await projectRepo.updateProject(projectId, data);
      return result.isErr() ? repoFailure(result.error) : ok(result.value);
    },

    async remove(projectId) {
      await projectRepo.deleteProject(projectId);
      return ok200();
    },

    async reorder(userId, projectIds) {
      const result = await projectRepo.reorderProjects(userId, projectIds);
      return result.isErr() ? err(failure(500, result.error.message)) : ok200();
    },

    async members(projectId) {
      return ok({ members: await pm.listMembersWithUsers(projectId) });
    },

    // Validates the role against the project-assignable set (unified-rbac-grants);
    // `owner` is the creator and is never assigned here.
    async addMember(projectId, userId, role = 'member') {
      if (!ASSIGNABLE_PROJECT_ROLES.has(role)) {
        return err({ ...failure(400, `Invalid role: ${role}`), code: 'invalid-project-role' });
      }
      return ok(await pm.addMember(projectId, userId, role));
    },

    async removeMember(actorId, projectId, userId) {
      if (
        actorId !== userId &&
        !(await authorizer.authorize(actorId, 'project', projectId, 'manage'))
      ) {
        return err(failure(403, 'Only project admins can remove members'));
      }
      await pm.removeMember(projectId, userId);
      return ok200();
    },

    // The path lives on the member's RUNNER, not on this server, so only the
    // lexical shape is checked; the runner reports a path that is not a repo.
    async setLocalPath(userId, projectId, localPath) {
      if (!isAbsolute(localPath)) return err(failure(400, 'Path must be absolute'));
      await pm.setMemberLocalPath(projectId, userId, resolve(localPath));
      return ok200();
    },

    async commands(projectId) {
      return ok((await cmdRepo.listCommands(projectId)).map(toStartupCommand));
    },

    async createCommand(projectId, { label, command }) {
      return ok(toStartupCommand(await cmdRepo.createCommand({ projectId, label, command })));
    },

    // Security CR-6: the command-id lookup is scoped to the parent project, so a
    // guessed id from another project cannot be modified or deleted.
    async updateCommand(projectId, commandId, { label, command, port, portEnvVar }) {
      await cmdRepo.updateCommand(commandId, projectId, { label, command, port, portEnvVar });
      return ok200();
    },

    async deleteCommand(projectId, commandId) {
      await cmdRepo.deleteCommand(commandId, projectId);
      return ok200();
    },
  };
}
