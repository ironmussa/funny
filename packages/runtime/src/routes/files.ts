/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { mkdir, readFile, writeFile, stat, realpath } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, join, normalize, resolve, sep } from 'path';

import { WORKTREE_DIR_NAME, getBlame } from '@funny/core/git';
import { badRequest, internal, notFound } from '@funny/shared/errors';
import { Hono } from 'hono';
import { ResultAsync, err } from 'neverthrow';

import { getServices } from '../services/service-registry.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resolveClaudeHomeConfigScope } from '../utils/claude-config-paths.js';
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

  // Scratch threads live outside any project under the per-user scratch root
  // (`<home>/.funny/scratch/<userId>/`). Authorize any path inside that root
  // for this user — cross-user isolation is enforced by including `userId`
  // in the path itself.
  const scratchRoot = normalize(resolve(homedir(), '.funny', 'scratch', userId));
  if (normalizedTarget === scratchRoot || normalizedTarget.startsWith(scratchRoot + sep)) {
    return { projectPath: scratchRoot, worktreeBase: scratchRoot };
  }

  const claudeConfig = resolveClaudeHomeConfigScope(normalizedTarget);
  if (claudeConfig) {
    return { projectPath: claudeConfig.scopeDir, worktreeBase: claudeConfig.scopeDir };
  }

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

/**
 * Resolve the user-supplied path to its canonical form by following all
 * symlinks. Eliminates the TOCTOU between an lstat-based symlink check and
 * the subsequent read/write — callers MUST perform I/O on the returned path,
 * never on the original user-supplied path, so a swap between check and use
 * cannot escape scope.
 *
 * For `allowMissing` (used by /write to create new files), canonicalize the
 * parent directory and rejoin the basename. The parent must already exist;
 * the basename is appended verbatim so we never re-introduce a swap window.
 */
async function canonicalize(
  filePath: string,
  allowMissing: boolean,
): Promise<
  | { ok: true; canonical: string; existed: boolean }
  | { ok: false; status: 404 | 500; error: string }
> {
  try {
    const canonical = await realpath(filePath);
    return { ok: true, canonical, existed: true };
  } catch (e: any) {
    if (e?.code !== 'ENOENT') return { ok: false, status: 500, error: 'File access error' };
    if (!allowMissing) return { ok: false, status: 404, error: 'File not found' };
    try {
      const parent = await realpath(dirname(filePath));
      return { ok: true, canonical: join(parent, basename(filePath)), existed: false };
    } catch {
      return { ok: false, status: 404, error: 'File not found' };
    }
  }
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

  // Resolve once via realpath; perform all subsequent I/O on the canonical
  // path so a symlink swap between check and read cannot escape scope.
  const canon = await canonicalize(filePath, false);
  if (!canon.ok) {
    return resultToResponse(
      c,
      err(canon.status === 404 ? notFound(canon.error) : internal(canon.error)),
    );
  }
  if (!isInScope(canon.canonical, scope)) return deny();

  // Check file size (max 10MB)
  const statsResult = await ResultAsync.fromPromise(stat(canon.canonical), (e: any) =>
    e.code === 'ENOENT' ? notFound('File not found') : internal('File access error'),
  );
  if (statsResult.isErr()) return resultToResponse(c, statsResult);
  if (statsResult.value.size > 10 * 1024 * 1024) {
    return resultToResponse(c, err(badRequest('File too large for internal editor (max 10MB)')));
  }

  const contentResult = await ResultAsync.fromPromise(
    readFile(canon.canonical, 'utf-8'),
    (e: any) => (e.code === 'ENOENT' ? notFound('File not found') : internal('File read error')),
  );
  if (contentResult.isErr()) return resultToResponse(c, contentResult);
  return c.json({ content: contentResult.value });
});

/**
 * Git blame for a file (per-line commit attribution against HEAD).
 * GET /api/files/blame?path=/absolute/path/to/file.ts
 *
 * Same project-scope/symlink-escape protections as /read. Backed by the native
 * gitoxide module; returns an error when the file is untracked, the repo can't
 * be discovered, or the native module is unavailable — the client treats any
 * failure as "no blame to show".
 */
app.get('/blame', async (c) => {
  const filePath = c.req.query('path');
  if (!filePath) {
    return c.json({ error: 'path is required' }, 400);
  }

  const userId = c.get('userId') as string;
  const scope = await resolveProjectScope(filePath, userId);
  if (!scope) return deny();

  const canon = await canonicalize(filePath, false);
  if (!canon.ok) {
    return resultToResponse(
      c,
      err(canon.status === 404 ? notFound(canon.error) : internal(canon.error)),
    );
  }
  if (!isInScope(canon.canonical, scope)) return deny();

  return resultToResponse(c, await getBlame(canon.canonical));
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

  const claudeConfig = resolveClaudeHomeConfigScope(normalize(resolve(filePath)));
  if (claudeConfig) {
    await mkdir(claudeConfig.scopeDir, { recursive: true });
  }

  // Resolve to a canonical path before the write. For new files (ENOENT) we
  // canonicalize the parent dir and rejoin the basename — the basename is not
  // followed as a symlink, so a swap between check and write cannot escape.
  const canon = await canonicalize(filePath, true);
  if (!canon.ok) {
    return resultToResponse(
      c,
      err(canon.status === 404 ? notFound(canon.error) : internal(canon.error)),
    );
  }
  if (!isInScope(canon.canonical, scope)) return deny();

  const writeResult = await ResultAsync.fromPromise(
    writeFile(canon.canonical, content, 'utf-8'),
    () => internal('File write error'),
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

  const canon = await canonicalize(filePath, false);
  if (!canon.ok) {
    return resultToResponse(
      c,
      err(canon.status === 404 ? notFound(canon.error) : internal(canon.error)),
    );
  }
  if (!isInScope(canon.canonical, scope)) return deny();

  const statsResult = await ResultAsync.fromPromise(stat(canon.canonical), (e: any) =>
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

  const ext = canon.canonical.includes('.')
    ? canon.canonical.substring(canon.canonical.lastIndexOf('.') + 1).toLowerCase()
    : '';
  const contentType = EXT_TO_MIME[ext] ?? 'application/octet-stream';

  // Bun.file returns a BunFile with a Web ReadableStream — passes straight
  // through Hono/Bun's Response without a Node-stream → Web-stream cast.
  const file = Bun.file(canon.canonical);
  return new Response(file, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(statsResult.value.size),
      'Cache-Control': 'private, max-age=60',
      'Content-Disposition': `inline; filename="${encodeURIComponent(basename(canon.canonical))}"`,
    },
  });
});

export default app;
