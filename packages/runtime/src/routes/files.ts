/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { mkdir, readFile, writeFile, stat, realpath } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, dirname, join, normalize, resolve, sep } from 'path';

import { WORKTREE_DIR_NAME, getBlame } from '@funny/core/git';
import { MEDIA_SIG_PARAMS, verifyMediaUrl } from '@funny/shared/auth/media-url-signature';
import { badRequest, internal, notFound } from '@funny/shared/errors';
import { Hono, type Context } from 'hono';
import { ResultAsync, err } from 'neverthrow';

import { getServices } from '../services/service-registry.js';
import { tmpAssetsDirName } from '../services/thread-context.js';
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

  // Browser-previewable dev assets the agent generates outside any project,
  // under a per-user namespaced temp root (`<os-tmpdir>/funny-<userId>/`). Same
  // isolation model as scratch: the userId in the path is the cross-user
  // boundary. We accept BOTH the resolve()'d and realpath()'d tmp base because
  // os.tmpdir() is itself a symlink on some platforms (macOS: /var →
  // /private/var) and the caller may supply either form; the scope we return is
  // the canonical (realpath) base so the post-canonicalize isInScope re-check
  // in streamRawFile matches the realpath'd target.
  const assetsName = tmpAssetsDirName(userId);
  const assetsBaseRaw = normalize(join(tmpdir(), assetsName));
  let assetsBaseReal = assetsBaseRaw;
  try {
    assetsBaseReal = normalize(join(await realpath(tmpdir()), assetsName));
  } catch {
    /* tmpdir unresolvable — fall back to the resolve()'d form */
  }
  const underAssets = (base: string) =>
    normalizedTarget === base || normalizedTarget.startsWith(base + sep);
  if (underAssets(assetsBaseRaw) || underAssets(assetsBaseReal)) {
    return { projectPath: assetsBaseReal, worktreeBase: assetsBaseReal };
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
/**
 * Parse a single-range HTTP `Range: bytes=…` header against a known file size.
 * Returns inclusive `{ start, end }` byte offsets, or null when there is no
 * range, the syntax is unsupported (multi-range), or the range is unsatisfiable
 * (caller then serves the full 200 body). Supports `start-end`, `start-`, and
 * the `-suffix` (last N bytes) forms.
 */
export function parseByteRange(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || size <= 0) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix range: last N bytes.
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  end = Math.min(end, size - 1);
  if (start > end || start < 0) return null;
  return { start, end };
}

/**
 * Resolve + scope-check + stream a raw file, honoring a `Range` request (206
 * partial content) so browsers can seek video/audio. Shared by `/raw`
 * (server-proxied, session/forwarded-identity auth) and `/raw-signed`
 * (browser-direct, HMAC auth). The caller MUST have already authorized
 * `filePath` for the request's user and passed the matching `scope` — this
 * enforces the symlink-escape re-check.
 */
async function streamRawFile(
  c: Context<HonoEnv>,
  filePath: string,
  scope: ProjectScope,
): Promise<Response> {
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
  const stats = statsResult.value;
  if (!stats.isFile()) {
    return resultToResponse(c, err(badRequest('Not a regular file')));
  }
  if (stats.size > RAW_MAX_SIZE) {
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
  const baseHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=60',
    'Content-Disposition': `inline; filename="${encodeURIComponent(basename(canon.canonical))}"`,
    // Advertise range support so media players enable seek. Note: over the
    // server's WS tunnel this header is filtered out by the proxy allowlist, so
    // seek only works on the direct path (`/raw-signed` or direct HTTP).
    'Accept-Ranges': 'bytes',
  };

  const range = parseByteRange(c.req.header('range'), stats.size);
  if (range) {
    const rangeHeaders = {
      ...baseHeaders,
      'Content-Range': `bytes ${range.start}-${range.end}/${stats.size}`,
      'Content-Length': String(range.end - range.start + 1),
    };
    // CRITICAL: a BunFile slice that ends before EOF must NOT be streamed.
    // `Bun.file().slice(start, end).stream()` ignores `end` and streams
    // start→EOF, and Bun.serve drops the explicit Content-Length — so the 206
    // body overruns the advertised `Content-Range`. Browsers reject that and a
    // `<video>`/`<audio>` fails to play or seek (looks like "could not be
    // displayed"). Materialize bounded ranges to an ArrayBuffer so the body
    // matches the range exactly; a range that already runs to EOF streams fine.
    if (range.end >= stats.size - 1) {
      return new Response(file.slice(range.start), { status: 206, headers: rangeHeaders });
    }
    const slice = await file.slice(range.start, range.end + 1).arrayBuffer();
    return new Response(slice, { status: 206, headers: rangeHeaders });
  }

  return new Response(file, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(stats.size) },
  });
}

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

  return streamRawFile(c, filePath, scope);
});

/**
 * Stream raw file contents authenticated by an HMAC-signed URL (transport C).
 * GET /api/files/raw-signed?path=…&u=<userId>&exp=<unixMs>&sig=<hex>
 *
 * This route is PUBLIC in the auth middleware (a cross-origin <img>/<video>
 * request carries no cookie or shared-secret header). Authentication is the
 * signature itself: the server minted it with `RUNNER_AUTH_SECRET`, binding the
 * path + user + expiry. We re-derive the user from the verified claim and run
 * the SAME per-user project-scope check as /raw — the signature is
 * authentication, NOT authorization (see media-url-signature.ts).
 */
app.get('/raw-signed', async (c) => {
  const secret = process.env.RUNNER_AUTH_SECRET;
  if (!secret) return deny();

  const verified = verifyMediaUrl(
    {
      path: c.req.query(MEDIA_SIG_PARAMS.path),
      userId: c.req.query(MEDIA_SIG_PARAMS.userId),
      expires: c.req.query(MEDIA_SIG_PARAMS.expires),
      signature: c.req.query(MEDIA_SIG_PARAMS.signature),
    },
    secret,
  );
  if (!verified.ok) {
    // 401 for expired/forged so the browser can distinguish from a 403 scope deny.
    return c.json({ error: `Invalid signed media URL: ${verified.reason}` }, 401);
  }

  const { path: filePath, userId } = verified.claim;
  // Re-run the SAME per-user scope check /raw does — the token authenticates the
  // user, it does not bypass authorization.
  const scope = await resolveProjectScope(filePath, userId);
  if (!scope) return deny();

  return streamRawFile(c, filePath, scope);
});

export default app;
