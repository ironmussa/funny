/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { readFile, writeFile, stat, lstat, realpath } from 'fs/promises';
import { basename, dirname, normalize, resolve, sep } from 'path';

import { WORKTREE_DIR_NAME } from '@funny/core/git';
import { badRequest, internal, notFound } from '@funny/shared/errors';
import { Hono } from 'hono';
import { ResultAsync, err } from 'neverthrow';

import { getServices } from '../services/service-registry.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';

const app = new Hono<HonoEnv>();

/**
 * Scope identifying the project + worktree base a path belongs to. Used to
 * pin symlink targets back to the same project so a symlink from project A
 * cannot escape into project B.
 */
type ProjectScope = { projectPath: string; worktreeBase: string };

/**
 * Resolve the project scope that owns `targetPath`, or null if no scope
 * matches. A match means the normalized target is the project root, the
 * worktree base, or a descendant of either (checked with `path + sep` to
 * block sibling-prefix escapes like `/a/bc` matching `/a/b`).
 */
async function resolveProjectScope(
  targetPath: string,
  userId: string,
): Promise<ProjectScope | null> {
  const normalizedTarget = normalize(resolve(targetPath));

  const projects = await getServices().projects.listProjects(userId);
  for (const project of projects) {
    const projectPath = normalize(resolve(project.path));
    const worktreeBase = normalize(
      resolve(dirname(projectPath), WORKTREE_DIR_NAME, basename(projectPath)),
    );
    const inProject =
      normalizedTarget === projectPath || normalizedTarget.startsWith(projectPath + sep);
    const inWorktree =
      normalizedTarget === worktreeBase || normalizedTarget.startsWith(worktreeBase + sep);
    if (inProject || inWorktree) return { projectPath, worktreeBase };
  }

  return null;
}

/** True if `targetPath` sits inside the given scope. */
function isInScope(targetPath: string, scope: ProjectScope): boolean {
  const normalizedTarget = normalize(resolve(targetPath));
  return (
    normalizedTarget === scope.projectPath ||
    normalizedTarget.startsWith(scope.projectPath + sep) ||
    normalizedTarget === scope.worktreeBase ||
    normalizedTarget.startsWith(scope.worktreeBase + sep)
  );
}

function deny(): Response {
  return new Response(
    JSON.stringify({ error: 'Access denied: path is outside allowed directories' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
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
  const scope = await resolveProjectScope(filePath, userId);
  if (!scope) return deny();

  // Check if file is binary
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  if (BINARY_EXTENSIONS.includes(ext)) {
    return resultToResponse(c, err(badRequest('Cannot edit binary files in internal editor')));
  }

  // Symlink escape check: if the requested path is a symlink, the realpath
  // must land back inside the SAME project scope. A symlink in project A
  // pointing into project B (or anywhere else) is rejected.
  const linkStatResult = await ResultAsync.fromPromise(lstat(filePath), (e: any) =>
    e.code === 'ENOENT' ? notFound('File not found') : internal('File access error'),
  );
  if (linkStatResult.isErr()) return resultToResponse(c, linkStatResult);
  if (linkStatResult.value.isSymbolicLink()) {
    const realPathResult = await ResultAsync.fromPromise(realpath(filePath), (e: any) =>
      e.code === 'ENOENT' ? notFound('File not found') : internal('File access error'),
    );
    if (realPathResult.isErr()) return resultToResponse(c, realPathResult);
    if (!isInScope(realPathResult.value, scope)) return deny();
  }

  // Check file size (max 10MB)
  const statsResult = await ResultAsync.fromPromise(stat(filePath), (e: any) =>
    e.code === 'ENOENT' ? notFound('File not found') : internal('File access error'),
  );
  if (statsResult.isErr()) return resultToResponse(c, statsResult);
  if (statsResult.value.size > 10 * 1024 * 1024) {
    return resultToResponse(c, err(badRequest('File too large for internal editor (max 10MB)')));
  }

  const contentResult = await ResultAsync.fromPromise(readFile(filePath, 'utf-8'), (e: any) =>
    e.code === 'ENOENT' ? notFound('File not found') : internal('File read error'),
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
  const scope = await resolveProjectScope(filePath, userId);
  if (!scope) return deny();

  // Symlink escape check: if the target exists and is a symlink, its realpath
  // must stay within the same project scope. New files legitimately miss
  // (ENOENT) — in that case there's no symlink to check.
  try {
    const linkStat = await lstat(filePath);
    if (linkStat.isSymbolicLink()) {
      const real = await realpath(filePath);
      if (!isInScope(real, scope)) return deny();
    }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      return resultToResponse(c, err(internal('File access error')));
    }
  }

  const writeResult = await ResultAsync.fromPromise(
    writeFile(filePath, content, 'utf-8'),
    (e: any) => internal('File write error'),
  );
  if (writeResult.isErr()) return resultToResponse(c, writeResult);
  return c.json({ ok: true });
});

/** Map common extensions to MIME types for the /raw endpoint. */
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

const RAW_MAX_SIZE = 100 * 1024 * 1024; // 100MB

/**
 * Stream raw file contents (binary or text) for media preview.
 * GET /api/files/raw?path=/absolute/path/to/file.png
 *
 * Same project-scope/symlink-escape protections as /read, but serves the
 * file as a stream with an inferred Content-Type so the browser can render
 * images, audio, video, PDFs, etc.
 */
app.get('/raw', async (c) => {
  const filePath = c.req.query('path');
  if (!filePath) {
    return c.json({ error: 'path is required' }, 400);
  }

  const userId = c.get('userId') as string;
  const scope = await resolveProjectScope(filePath, userId);
  if (!scope) return deny();

  const linkStatResult = await ResultAsync.fromPromise(lstat(filePath), (e: any) =>
    e.code === 'ENOENT' ? notFound('File not found') : internal('File access error'),
  );
  if (linkStatResult.isErr()) return resultToResponse(c, linkStatResult);
  if (linkStatResult.value.isSymbolicLink()) {
    const realPathResult = await ResultAsync.fromPromise(realpath(filePath), (e: any) =>
      e.code === 'ENOENT' ? notFound('File not found') : internal('File access error'),
    );
    if (realPathResult.isErr()) return resultToResponse(c, realPathResult);
    if (!isInScope(realPathResult.value, scope)) return deny();
  }

  const statsResult = await ResultAsync.fromPromise(stat(filePath), (e: any) =>
    e.code === 'ENOENT' ? notFound('File not found') : internal('File access error'),
  );
  if (statsResult.isErr()) return resultToResponse(c, statsResult);
  if (!statsResult.value.isFile()) {
    return resultToResponse(c, err(badRequest('Not a regular file')));
  }
  if (statsResult.value.size > RAW_MAX_SIZE) {
    return resultToResponse(
      c,
      err(badRequest(`File too large for preview (max ${RAW_MAX_SIZE} bytes)`)),
    );
  }

  const ext = filePath.includes('.')
    ? filePath.substring(filePath.lastIndexOf('.') + 1).toLowerCase()
    : '';
  const contentType = EXT_TO_MIME[ext] ?? 'application/octet-stream';

  // Bun.file returns a BunFile with a Web ReadableStream — passes straight
  // through Hono/Bun's Response without a Node-stream → Web-stream cast.
  const file = Bun.file(filePath);
  return new Response(file, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(statsResult.value.size),
      'Cache-Control': 'private, max-age=60',
      'Content-Disposition': `inline; filename="${encodeURIComponent(basename(filePath))}"`,
    },
  });
});

export default app;
