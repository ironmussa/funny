/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { normalize, resolve } from 'path';

import { badRequest, internal, notFound } from '@funny/shared/errors';
import { Hono } from 'hono';
import { ResultAsync, err } from 'neverthrow';

import * as pm from '../services/project-manager.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';

const app = new Hono<HonoEnv>();

/**
 * Check if a path is within an allowed directory.
 * Scoped to the requesting user's projects in multi-user mode.
 */
async function isPathAllowed(targetPath: string, userId: string): Promise<boolean> {
  const normalizedTarget = normalize(resolve(targetPath));

  const home = normalize(resolve(homedir()));
  if (normalizedTarget.startsWith(home)) return true;

  const projects = await pm.listProjects(userId);
  for (const project of projects) {
    const projectPath = normalize(resolve(project.path));
    if (normalizedTarget.startsWith(projectPath)) return true;
    if (projectPath.startsWith(normalizedTarget)) return true;
  }

  return false;
}

/** Return 403 response if path is not in an allowed directory */
async function checkAllowedPath(path: string, userId: string): Promise<Response | null> {
  if (!(await isPathAllowed(path, userId))) {
    return new Response(
      JSON.stringify({ error: 'Access denied: path is outside allowed directories' }),
      {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
  return null;
}

/** Binary file extensions that should not be edited in the internal editor */
const BINARY_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svg',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.mp3',
  '.mp4',
  '.wav',
  '.avi',
  '.mov',
  '.ttf',
  '.woff',
  '.woff2',
  '.eot',
];

/**
 * Read file contents
 * GET /api/files/read?path=/absolute/path/to/file.ts
 */
app.get('/read', async (c) => {
  const filePath = c.req.query('path');
  if (!filePath) {
    return c.json({ error: 'path is required' }, 400);
  }

  const userId = c.get('userId') as string;
  const denied = await checkAllowedPath(filePath, userId);
  if (denied) return denied;

  // Check if file is binary
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  if (BINARY_EXTENSIONS.includes(ext)) {
    return resultToResponse(c, err(badRequest('Cannot edit binary files in internal editor')));
  }

  // Check file size (max 2MB)
  const statsResult = await ResultAsync.fromPromise(stat(filePath), (e: any) =>
    e.code === 'ENOENT' ? notFound('File not found') : internal(e.message),
  );
  if (statsResult.isErr()) return resultToResponse(c, statsResult);
  if (statsResult.value.size > 2 * 1024 * 1024) {
    return resultToResponse(c, err(badRequest('File too large for internal editor (max 2MB)')));
  }

  const contentResult = await ResultAsync.fromPromise(readFile(filePath, 'utf-8'), (e: any) =>
    e.code === 'ENOENT' ? notFound('File not found') : internal(e.message),
  );
  if (contentResult.isErr()) return resultToResponse(c, contentResult);
  return c.json({ content: contentResult.value });
});

/**
 * Write file contents
 * POST /api/files/write
 * Body: { path: string, content: string }
 */
app.post('/write', async (c) => {
  const body = await c.req.json<{ path?: string; content?: string }>();
  const { path: filePath, content } = body;

  if (!filePath) {
    return c.json({ error: 'path is required' }, 400);
  }
  if (content === undefined) {
    return c.json({ error: 'content is required' }, 400);
  }

  const userId = c.get('userId') as string;
  const denied = await checkAllowedPath(filePath, userId);
  if (denied) return denied;

  const writeResult = await ResultAsync.fromPromise(
    writeFile(filePath, content, 'utf-8'),
    (e: any) => internal(e.message),
  );
  if (writeResult.isErr()) return resultToResponse(c, writeResult);
  return c.json({ ok: true });
});

export default app;
