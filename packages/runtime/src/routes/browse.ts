/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { readdirSync, existsSync, statSync, mkdirSync } from 'fs';
import { homedir, platform } from 'os';
import { join, parse as parsePath, resolve, normalize } from 'path';

import { getRemoteUrl, extractRepoName, initRepo } from '@funny/core/git';
import { Hono } from 'hono';

import { getFileIndex, getFileIndexDelta } from '../services/file-index-service.js';
import { getServices } from '../services/service-registry.js';
import { resolveThreadCwd } from '../services/thread-context.js';
import * as tm from '../services/thread-manager.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resolveGitFiles } from '../utils/git-files.js';
import { requirePickerPath, requireProjectPath } from '../utils/path-scope.js';
import { resultToResponse } from '../utils/result-response.js';

const app = new Hono<HonoEnv>();

/** Return 400 response if value is missing */
function checkRequired(value: string | undefined, label = 'path'): string | Response {
  if (!value) {
    return new Response(JSON.stringify({ error: `${label} is required` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return value;
}

// List drives (Windows) or root dirs
app.get('/roots', (c) => {
  try {
    const drives: string[] = [];
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      const drive = `${letter}:\\`;
      try {
        readdirSync(drive);
        drives.push(drive);
      } catch {
        // drive doesn't exist or isn't accessible
      }
    }
    return c.json({ roots: drives, home: homedir() });
  } catch {
    return c.json({ error: 'Failed to list drive roots' }, 500);
  }
});

// List subdirectories of a given path
app.get('/list', async (c) => {
  const dirPathOrRes = checkRequired(c.req.query('path'), 'path query parameter');
  if (dirPathOrRes instanceof Response) return dirPathOrRes;
  const dirPath = dirPathOrRes;

  const denied = await requirePickerPath(dirPath);
  if (denied) return denied;
  if (!existsSync(normalize(resolve(dirPath)))) {
    return c.json({ error: 'Directory does not exist' }, 404);
  }

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter((e) => {
        if (!e.isDirectory()) return false;
        if (
          e.name.startsWith('.') ||
          e.name === 'node_modules' ||
          e.name === '$Recycle.Bin' ||
          e.name === 'System Volume Information'
        )
          return false;
        return true;
      })
      .map((e) => ({
        name: e.name,
        path: join(dirPath, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parsed = parsePath(dirPath);
    const parent = parsed.dir || null;

    return c.json({ path: dirPath, parent, dirs });
  } catch {
    const parsed = parsePath(dirPath);
    const parent = parsed.dir || null;
    return c.json({ path: dirPath, parent, dirs: [], error: 'Failed to read directory' });
  }
});

// Get git repo name from remote origin for a given path
app.get('/repo-name', async (c) => {
  const dirPathOrRes = checkRequired(c.req.query('path'), 'path query parameter');
  if (dirPathOrRes instanceof Response) return dirPathOrRes;
  const dirPath = dirPathOrRes;

  const denied = await requirePickerPath(dirPath);
  if (denied) return denied;

  const remoteResult = await getRemoteUrl(dirPath);
  if (remoteResult.isOk() && remoteResult.value) {
    const name = extractRepoName(remoteResult.value);
    return c.json({ name });
  }

  const folderName = dirPath.split(/[\\/]/).filter(Boolean).pop() || '';
  return c.json({ name: folderName });
});

// Get git remote origin URL for a given path
app.get('/remote-url', async (c) => {
  const dirPathOrRes = checkRequired(c.req.query('path'), 'path query parameter');
  if (dirPathOrRes instanceof Response) return dirPathOrRes;
  const dirPath = dirPathOrRes;

  const denied = await requirePickerPath(dirPath);
  if (denied) return denied;

  const remoteResult = await getRemoteUrl(dirPath);
  if (remoteResult.isOk() && remoteResult.value) {
    return c.json({ url: remoteResult.value.trim() });
  }

  return c.json({ url: null });
});

// Initialize a git repo at the given path
app.post('/git-init', async (c) => {
  const { path: dirPath } = await c.req.json<{ path: string }>();
  if (!dirPath) return c.json({ error: 'path is required' }, 400);

  // Picker scope: git-init runs during project creation, before a project
  // record exists. Constrained to $HOME (minus credential dirs).
  const denied = await requirePickerPath(dirPath);
  if (denied) return denied;

  const result = await initRepo(dirPath);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// Create a new directory inside a given parent path
app.post('/create-directory', async (c) => {
  const { parent, name } = await c.req.json<{ parent: string; name: string }>();
  if (!parent) return c.json({ error: 'parent is required' }, 400);
  if (!name) return c.json({ error: 'name is required' }, 400);

  // Security M7: validate directory name.
  // - Reject path separators and control characters that could break out of
  //   `parent` via `join()`.
  // - Reject `.`/`..` which are traversal primitives regardless of separator
  //   presence (e.g. `join(parent, '..')` climbs above the scope).
  // - Reject Windows-reserved device names (`CON`, `PRN`, `AUX`, `NUL`,
  //   `COM1..9`, `LPT1..9`) — a created file/dir with these names on Windows
  //   aliases a device and can be abused by a later open/read.
  // - Reject trailing `.` / trailing space which Windows silently strips,
  //   letting `"foo "` masquerade as `"foo"`.
  const unsafeDirectoryNamePattern = new RegExp(String.raw`[/\\<>:"|?*\u0000-\u001F]`);

  if (unsafeDirectoryNamePattern.test(name)) {
    return c.json({ error: 'Invalid directory name' }, 400);
  }
  if (name === '.' || name === '..') {
    return c.json({ error: 'Invalid directory name' }, 400);
  }
  if (/[. ]$/.test(name)) {
    return c.json({ error: 'Invalid directory name' }, 400);
  }
  const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
  if (WINDOWS_RESERVED.test(name)) {
    return c.json({ error: 'Invalid directory name' }, 400);
  }

  const denied = await requirePickerPath(parent);
  if (denied) return denied;

  const newPath = join(parent, name);

  if (existsSync(newPath)) {
    return c.json({ error: 'A folder with that name already exists' }, 409);
  }

  try {
    mkdirSync(newPath, { recursive: true });
    return c.json({ ok: true, path: newPath });
  } catch {
    return c.json({ error: 'Failed to create directory' }, 500);
  }
});

/**
 * Resolve `{ path }` or `{ threadId }` from the request body into an absolute
 * directory path. Returns either the resolved path (string) or a `Response`
 * to short-circuit the handler. When `threadId` is supplied, ownership is
 * verified and scratch dirs are mkdir'd on demand so the caller can rely on
 * the path existing.
 */
async function resolveBodyPath(
  body: { path?: string; threadId?: string },
  userId: string,
): Promise<string | Response> {
  if (body.threadId) {
    const thread = await tm.getThread(body.threadId);
    if (!thread || thread.userId !== userId) {
      return new Response(JSON.stringify({ error: 'Thread not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const project = thread.projectId
      ? await getServices().projects.getProject(thread.projectId)
      : null;
    const cwdResult = resolveThreadCwd(
      thread as unknown as Parameters<typeof resolveThreadCwd>[0],
      project ? { path: project.path } : null,
    );
    if (cwdResult.isErr()) {
      return new Response(JSON.stringify({ error: cwdResult.error.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const cwd = cwdResult.value;
    if (thread.isScratch) {
      try {
        mkdirSync(cwd, { recursive: true });
      } catch {
        // Will fall through to the existsSync check in the caller.
      }
    }
    return cwd;
  }
  if (!body.path) {
    return new Response(JSON.stringify({ error: 'path or threadId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const denied = await requireProjectPath(body.path, userId);
  if (denied) return denied;
  return body.path;
}

// Open directory in file explorer
app.post('/open-directory', async (c) => {
  const body = await c.req.json<{ path?: string; threadId?: string }>();
  const userId = c.get('userId') as string;
  const resolved = await resolveBodyPath(body, userId);
  if (resolved instanceof Response) return resolved;
  const dirPath = resolved;

  // Normalize and resolve the path to its absolute form
  const normalizedPath = normalize(resolve(dirPath));

  // Validate directory exists before opening
  if (!existsSync(normalizedPath)) {
    return c.json({ error: 'Directory does not exist' }, 404);
  }

  try {
    const stat = statSync(normalizedPath);
    if (!stat.isDirectory()) {
      return c.json({ error: 'Path is not a directory' }, 400);
    }
  } catch {
    return c.json({ error: 'Cannot access directory' }, 500);
  }

  const os = platform();
  let cmd: string;
  let args: string[];

  if (os === 'win32') {
    cmd = 'explorer';
    args = [normalizedPath.replace(/\//g, '\\')];
  } else if (os === 'darwin') {
    cmd = 'open';
    args = [normalizedPath];
  } else {
    cmd = 'xdg-open';
    args = [normalizedPath];
  }

  Bun.spawn([cmd, ...args], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  return c.json({ ok: true });
});

// Open project in editor
app.post('/open-in-editor', async (c) => {
  const { path: dirPath, editor } = await c.req.json<{ path: string; editor: string }>();
  if (!dirPath) return c.json({ error: 'path is required' }, 400);
  if (!editor) return c.json({ error: 'editor is required' }, 400);
  const userId = c.get('userId') as string;

  const denied = await requireProjectPath(dirPath, userId);
  if (denied) return denied;

  const editorCommands: Record<string, { cmd: string; args: string[] }> = {
    vscode: { cmd: 'code', args: [dirPath] },
    cursor: { cmd: 'cursor', args: [dirPath] },
    windsurf: { cmd: 'windsurf', args: [dirPath] },
    zed: { cmd: 'zed', args: [dirPath] },
    sublime: { cmd: 'subl', args: [dirPath] },
    vim:
      platform() === 'win32'
        ? { cmd: 'cmd', args: ['/c', 'start', 'cmd', '/k', 'vim', dirPath] }
        : { cmd: 'x-terminal-emulator', args: ['-e', 'vim', dirPath] },
  };

  const editorConfig = editorCommands[editor];
  if (!editorConfig) return c.json({ error: `Unknown editor: ${editor}` }, 400);

  try {
    Bun.spawn([editorConfig.cmd, ...editorConfig.args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to open editor' }, 500);
  }
});

/** Simple fuzzy match: all characters of the query appear in order within the text */
function fuzzyMatch(text: string, query: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

/** Extract the file name from a path */
function getFileName(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}

const FILE_SEARCH_LIMIT = 100;
const FILE_BROWSE_MAX_LIMIT = 20000;

export type BrowseItem = { path: string; type: 'file' | 'folder' };

/** Score a candidate name/path against a lowercased query, or -1 for no match. */
function scoreCandidate(name: string, fullPath: string, lowerQuery: string): number {
  if (name.startsWith(lowerQuery)) return 0; // name starts with query — best match
  if (name.includes(lowerQuery)) return 1; // exact substring in name
  if (fuzzyMatch(name, lowerQuery)) return 2; // fuzzy match in name
  if (fullPath.includes(lowerQuery)) return 3; // match somewhere in the path
  if (fuzzyMatch(fullPath, lowerQuery)) return 4; // fuzzy match in full path
  return -1;
}

/**
 * Scored search over a flat file list. Folders are derived from the file paths
 * and matched too, so a query like `@somedir` surfaces the directory itself as
 * a selectable item — not only the files inside it. Folders are biased slightly
 * ahead of equally-scored files so the directory the user typed isn't buried
 * under its own children.
 */
export function searchFilesAndFolders(
  allFiles: string[],
  query: string,
  limit = FILE_SEARCH_LIMIT,
): { files: BrowseItem[]; truncated: boolean } {
  const lowerQuery = query.toLowerCase();
  const scored: Array<{ item: BrowseItem; score: number }> = [];

  // Derive every ancestor directory from the file list (resolveGitFiles only
  // returns files), so folders become selectable.
  const dirSet = new Set<string>();
  for (const filePath of allFiles) {
    let slash = filePath.indexOf('/');
    while (slash !== -1) {
      dirSet.add(filePath.slice(0, slash));
      slash = filePath.indexOf('/', slash + 1);
    }
  }

  for (const dirEntry of dirSet) {
    const score = scoreCandidate(
      getFileName(dirEntry).toLowerCase(),
      dirEntry.toLowerCase(),
      lowerQuery,
    );
    if (score >= 0) {
      scored.push({ item: { path: dirEntry, type: 'folder' }, score: score - 0.5 });
    }
  }

  for (const filePath of allFiles) {
    const score = scoreCandidate(
      getFileName(filePath).toLowerCase(),
      filePath.toLowerCase(),
      lowerQuery,
    );
    if (score >= 0) {
      scored.push({ item: { path: filePath, type: 'file' }, score });
    }
  }

  scored.sort((a, b) => a.score - b.score);
  const truncated = scored.length > limit;
  return { files: scored.slice(0, limit).map((s) => s.item), truncated };
}

/**
 * Return the full file index for a project. Used by the client-side fuzzy
 * search (Ctrl+P) — clients fetch once, then score locally on every keystroke.
 * Supports `?since=<version>` for cheap no-op responses when the index hasn't
 * changed since the client's last fetch.
 *
 * Two addressing modes:
 *   - `?path=<absolute>` — auth via {@link requireProjectPath} (project scope).
 *   - `?threadId=<id>` — auth via thread ownership; the cwd is resolved via
 *     {@link resolveThreadCwd}, which covers scratch / worktree / normal
 *     threads uniformly. The response includes `basePath` so the client can
 *     build absolute paths for opening files.
 */
app.get('/files/index', async (c) => {
  const userId = c.get('userId') as string;
  const threadIdParam = c.req.query('threadId');
  const pathParam = c.req.query('path');

  let dirPath: string;
  let resolvedBasePath: string | null = null;

  if (threadIdParam) {
    const thread = await tm.getThread(threadIdParam);
    if (!thread || thread.userId !== userId) {
      return c.json({ error: 'Thread not found' }, 404);
    }
    const project = thread.projectId
      ? await getServices().projects.getProject(thread.projectId)
      : null;
    const cwdResult = resolveThreadCwd(
      thread as unknown as Parameters<typeof resolveThreadCwd>[0],
      project ? { path: project.path } : null,
    );
    if (cwdResult.isErr()) {
      return c.json({ error: cwdResult.error.message }, 400);
    }
    dirPath = cwdResult.value;
    resolvedBasePath = dirPath;
    // Scratch dirs are created lazily on first agent run. Ctrl+P may be opened
    // before that, so ensure the dir exists; an empty fs walk is fine.
    if (thread.isScratch) {
      try {
        mkdirSync(dirPath, { recursive: true });
      } catch {
        // Will surface as an empty index — acceptable.
      }
    }
  } else {
    const dirPathOrRes = checkRequired(pathParam, 'path or threadId query parameter');
    if (dirPathOrRes instanceof Response) return dirPathOrRes;
    dirPath = dirPathOrRes;
    const denied = await requireProjectPath(dirPath, userId);
    if (denied) return denied;
  }

  const sinceParam = c.req.query('since');
  const since = sinceParam ? Number(sinceParam) : NaN;

  if (Number.isFinite(since) && since > 0) {
    const delta = getFileIndexDelta(dirPath, since);
    if (delta && delta.unchanged) {
      return c.json({
        unchanged: true,
        version: delta.version,
        ...(resolvedBasePath ? { basePath: resolvedBasePath } : {}),
      });
    }
  }

  const snapshotResult = await getFileIndex(dirPath);
  if (snapshotResult.isErr()) return resultToResponse(c, snapshotResult);
  return c.json({
    files: snapshotResult.value.files,
    version: snapshotResult.value.version,
    ...(resolvedBasePath ? { basePath: resolvedBasePath } : {}),
  });
});

// List files and folders in a git repository (respects .gitignore)
app.get('/files', async (c) => {
  const dirPathOrRes = checkRequired(c.req.query('path'), 'path query parameter');
  if (dirPathOrRes instanceof Response) return dirPathOrRes;
  const dirPath = dirPathOrRes;
  const userId = c.get('userId') as string;

  const denied = await requireProjectPath(dirPath, userId);
  if (denied) return denied;

  const query = c.req.query('query') || '';
  const limitParam = Number(c.req.query('limit'));
  const requestedLimit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, FILE_BROWSE_MAX_LIMIT)
      : FILE_SEARCH_LIMIT;

  try {
    const allFiles = await resolveGitFiles(dirPath);

    if (allFiles.length === 0) {
      return c.json({ files: [], truncated: false });
    }

    if (!query) {
      // No query — return first N files (no folders needed for search dialog)
      const files: BrowseItem[] = allFiles.slice(0, requestedLimit).map((f) => ({
        path: f,
        type: 'file' as const,
      }));
      return c.json({ files, truncated: allFiles.length > requestedLimit });
    }

    return c.json(searchFilesAndFolders(allFiles, query));
  } catch {
    return c.json({ files: [], truncated: false, error: 'Failed to search files' });
  }
});

// ── Symbol search routes ─────────────────────────────────────

import { indexProject, searchSymbols, isIndexing } from '../services/symbol-index-service.js';

// Search symbols in a project
app.get('/symbols', async (c) => {
  const dirPathOrRes = checkRequired(c.req.query('path'), 'path query parameter');
  if (dirPathOrRes instanceof Response) return dirPathOrRes;
  const dirPath = dirPathOrRes;
  const userId = c.get('userId') as string;

  const denied = await requireProjectPath(dirPath, userId);
  if (denied) return denied;

  const query = c.req.query('query') || '';
  const file = c.req.query('file') || undefined;

  // If not indexed yet, trigger background indexing
  const indexing = isIndexing(dirPath);
  const result = searchSymbols(dirPath, query, file);

  if (!result.indexed && !indexing) {
    // Fire-and-forget indexing
    indexProject(dirPath).catch(() => {});
  }

  return c.json(result);
});

// Trigger symbol indexing for a project
app.post('/symbols/index', async (c) => {
  const { path: dirPath } = await c.req.json<{ path: string }>();
  if (!dirPath) return c.json({ error: 'path is required' }, 400);
  const userId = c.get('userId') as string;

  const denied = await requireProjectPath(dirPath, userId);
  if (denied) return denied;

  // Fire-and-forget indexing
  indexProject(dirPath).catch(() => {});

  return c.json({ ok: true });
});

export default app;
