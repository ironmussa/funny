import { readFile, writeFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { normalize, resolve } from 'path';

import { Hono } from 'hono';

import * as pm from '../services/project-manager.js';
import type { HonoEnv } from '../types/hono-env.js';

const app = new Hono<HonoEnv>();

/**
 * Check if a path is within an allowed directory.
 * Scoped to the requesting user's projects in multi-user mode.
 */
function isPathAllowed(targetPath: string, userId: string): boolean {
  const normalizedTarget = normalize(resolve(targetPath));

  const home = normalize(resolve(homedir()));
  if (normalizedTarget.startsWith(home)) return true;

  const projects = pm.listProjects(userId);
  for (const project of projects) {
    const projectPath = normalize(resolve(project.path));
    if (normalizedTarget.startsWith(projectPath)) return true;
    if (projectPath.startsWith(normalizedTarget)) return true;
  }

  return false;
}

/** Return 403 response if path is not in an allowed directory */
function checkAllowedPath(path: string, userId: string): Response | null {
  if (!isPathAllowed(path, userId)) {
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
  const denied = checkAllowedPath(filePath, userId);
  if (denied) return denied;

  try {
    // Check if file is binary
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    if (BINARY_EXTENSIONS.includes(ext)) {
      return c.json({ error: 'Cannot edit binary files in internal editor' }, 400);
    }

    // Check file size (max 2MB)
    const stats = await stat(filePath);
    if (stats.size > 2 * 1024 * 1024) {
      return c.json({ error: 'File too large for internal editor (max 2MB)' }, 400);
    }

    const content = await readFile(filePath, 'utf-8');
    return c.json({ content });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return c.json({ error: 'File not found' }, 404);
    }
    return c.json({ error: error.message }, 500);
  }
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
  const denied = checkAllowedPath(filePath, userId);
  if (denied) return denied;

  try {
    await writeFile(filePath, content, 'utf-8');
    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
