/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { readdirSync, existsSync, statSync, mkdirSync } from 'fs';
import { homedir, platform } from 'os';
import { join, parse as parsePath, resolve, normalize, sep } from 'path';

import { getRemoteUrl, extractRepoName, initRepo } from '@funny/core/git';
import { Hono } from 'hono';

import { getServices } from '../services/service-registry.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resolveGitFiles } from '../utils/git-files.js';
import { resultToResponse } from '../utils/result-response.js';

const app = new Hono<HonoEnv>();

/**
 * Check if a path is within an allowed directory.
 * Scoped to the requesting user's projects in multi-user mode.
 */
async function isPathAllowed(targetPath: string, userId: string): Promise<boolean> {
  const normalizedTarget = normalize(resolve(targetPath));

  // Sensitive paths that must never be accessible, even within the home directory
  const home = normalize(resolve(homedir()));
  const denyList = ['.ssh', '.aws', '.gnupg', '.funny', '.config/gh'].map((p) =>
    normalize(resolve(home, p)),
  );
  for (const denied of denyList) {
    if (normalizedTarget === denied || normalizedTarget.startsWith(denied + sep)) return false;
  }

  const projects = await getServices().projects.listProjects(userId);
  for (const project of projects) {
    const projectPath = normalize(resolve(project.path));
    // Use path separator check to prevent sibling directory traversal
    // e.g., /home/user/app must not match /home/user/app-secrets
    if (normalizedTarget === projectPath || normalizedTarget.startsWith(projectPath + sep))
      return true;
    // Allow browsing parent directories that contain a project (for folder picker)
    if (projectPath.startsWith(normalizedTarget + sep)) return true;
  }

  // Allow browsing the home directory itself (for folder picker navigation)
  // but NOT arbitrary subdirectories — only project paths and their parents
  if (normalizedTarget === home) return true;

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
  const userId = c.get('userId') as string;

  const denied = await checkAllowedPath(dirPath, userId);
  if (denied) return denied;

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
  const userId = c.get('userId') as string;

  const denied = await checkAllowedPath(dirPath, userId);
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
  const userId = c.get('userId') as string;

  const denied = await checkAllowedPath(dirPath, userId);
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
  const userId = c.get('userId') as string;

  const denied = await checkAllowedPath(dirPath, userId);
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

  // Validate directory name (no path separators or special chars)
  // eslint-disable-next-line no-control-regex
  if (/[/\\<>:"|?*\x00-\x1f]/.test(name)) {
    return c.json({ error: 'Invalid directory name' }, 400);
  }

  const userId = c.get('userId') as string;
  const denied = await checkAllowedPath(parent, userId);
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

// Open directory in file explorer
app.post('/open-directory', async (c) => {
  const { path: dirPath } = await c.req.json<{ path: string }>();
  if (!dirPath) return c.json({ error: 'path is required' }, 400);
  const userId = c.get('userId') as string;

  const denied = await checkAllowedPath(dirPath, userId);
  if (denied) return denied;

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

  const denied = await checkAllowedPath(dirPath, userId);
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

// Open terminal at directory
app.post('/open-terminal', async (c) => {
  const { path: dirPath } = await c.req.json<{ path: string }>();
  if (!dirPath) return c.json({ error: 'path is required' }, 400);
  const userId = c.get('userId') as string;

  const denied = await checkAllowedPath(dirPath, userId);
  if (denied) return denied;

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
    cmd = 'cmd';
    args = ['/c', 'start', 'cmd'];
  } else if (os === 'darwin') {
    cmd = 'open';
    args = ['-a', 'Terminal', dirPath];
  } else {
    cmd = 'x-terminal-emulator';
    args = ['--working-directory', dirPath];
  }

  Bun.spawn([cmd, ...args], {
    cwd: dirPath,
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  return c.json({ ok: true });
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

// List files and folders in a git repository (respects .gitignore)
app.get('/files', async (c) => {
  const dirPathOrRes = checkRequired(c.req.query('path'), 'path query parameter');
  if (dirPathOrRes instanceof Response) return dirPathOrRes;
  const dirPath = dirPathOrRes;
  const userId = c.get('userId') as string;

  const denied = await checkAllowedPath(dirPath, userId);
  if (denied) return denied;

  const query = c.req.query('query') || '';

  try {
    const allFiles = await resolveGitFiles(dirPath);

    if (allFiles.length === 0) {
      return c.json({ files: [], truncated: false });
    }

    type BrowseItem = { path: string; type: 'file' | 'folder' };

    if (!query) {
      // No query — return first N files (no folders needed for search dialog)
      const files: BrowseItem[] = allFiles.slice(0, FILE_SEARCH_LIMIT).map((f) => ({
        path: f,
        type: 'file' as const,
      }));
      return c.json({ files, truncated: allFiles.length > FILE_SEARCH_LIMIT });
    }

    // Server-side scored search
    const lowerQuery = query.toLowerCase();
    const scored: Array<{ item: BrowseItem; score: number }> = [];

    for (const filePath of allFiles) {
      const fileName = getFileName(filePath).toLowerCase();
      const lowerPath = filePath.toLowerCase();

      let score = -1;
      if (fileName.startsWith(lowerQuery)) {
        score = 0; // Filename starts with query — best match
      } else if (fileName.includes(lowerQuery)) {
        score = 1; // Exact substring in filename
      } else if (fuzzyMatch(fileName, lowerQuery)) {
        score = 2; // Fuzzy match in filename
      } else if (lowerPath.includes(lowerQuery)) {
        score = 3; // Match in directory path
      } else if (fuzzyMatch(lowerPath, lowerQuery)) {
        score = 4; // Fuzzy match in full path
      }

      if (score >= 0) {
        scored.push({ item: { path: filePath, type: 'file' as const }, score });
      }
    }

    scored.sort((a, b) => a.score - b.score);
    const truncated = scored.length > FILE_SEARCH_LIMIT;
    const files = scored.slice(0, FILE_SEARCH_LIMIT).map((s) => s.item);

    return c.json({ files, truncated });
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

  const denied = await checkAllowedPath(dirPath, userId);
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

  const denied = await checkAllowedPath(dirPath, userId);
  if (denied) return denied;

  // Fire-and-forget indexing
  indexProject(dirPath).catch(() => {});

  return c.json({ ok: true });
});

export default app;
