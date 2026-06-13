/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ServiceProvider
 *
 * Runner-side project creation.
 *
 * Project CRUD normally lives on the server, but in team mode the project path
 * lives on THIS host (the runner) — the server's filesystem and $HOME are
 * unrelated, so it cannot validate the path (git-repo + $HOME containment
 * always fail there). The server therefore proxies `POST /api/projects` here:
 * we run the HI-3 containment check against the runner's OWN filesystem, verify
 * it is a git repo root, and then persist the record back on the server via the
 * data channel (`createProject` → `data:create_project`, which the server
 * applies with `skipFsCheck=true`).
 */

import { isGitRepoSync, isGitRepoRootSync, validateProjectRootPath } from '@funny/core/git';
import { badRequest } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { getServices } from '../../services/service-registry.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { createProjectSchema, validate } from '../../validation/schemas.js';

export const projectCreateRoutes = new Hono<HonoEnv>();

// POST /api/projects — validate the path on the runner's filesystem, then
// persist the project record on the server.
projectCreateRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');

  const body = await c.req.json().catch(() => null);
  const parsed = validate(createProjectSchema, body);
  if (parsed.isErr()) return resultToResponse(c, err(parsed.error));
  const { name, path } = parsed.value;

  // HI-3 containment runs HERE — the host that owns the files — against the
  // runner's own $HOME / FUNNY_PROJECT_ROOT. Returns the resolved realpath.
  const validated = validateProjectRootPath(path);
  if (validated.isErr()) return resultToResponse(c, err(validated.error));
  const resolvedPath = validated.value;

  if (!isGitRepoSync(resolvedPath)) {
    return resultToResponse(c, err(badRequest(`Not a git repository: ${resolvedPath}`)));
  }
  if (!isGitRepoRootSync(resolvedPath)) {
    return resultToResponse(
      c,
      err(
        badRequest(
          `Path is nested inside another git repository (not the repo root): ${resolvedPath}. Run "git init" in this directory, or pick the repo's actual root.`,
        ),
      ),
    );
  }

  const result = await getServices().projects.createProject(name, resolvedPath, userId, orgId);
  if (result.isErr()) {
    log.warn('Runner-side createProject failed', {
      namespace: 'project-routes',
      path: resolvedPath,
      error: result.error.message,
    });
  }
  return resultToResponse(c, result, 201);
});
