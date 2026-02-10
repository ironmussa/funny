import { Hono } from 'hono';
import { readdirSync } from 'fs';
import { join, parse as parsePath, resolve, normalize } from 'path';
import { homedir, platform } from 'os';
import { getRemoteUrl, extractRepoName, initRepo } from '../utils/git-v2.js';
import * as pm from '../services/project-manager.js';
import { BadRequest, Forbidden } from '../middleware/error-handler.js';

const app = new Hono();

/**
 * Check if a path is within an allowed directory:
 * - The user's home directory (and subtrees)
 * - Any registered project path (and subtrees)
 * - Ancestor directories of registered projects (so the folder picker can navigate to them)
 */
function isPathAllowed(targetPath: string): boolean {
  const normalizedTarget = normalize(resolve(targetPath));

  // Allow anything under the user's home directory
  const home = normalize(resolve(homedir()));
  if (normalizedTarget.startsWith(home)) return true;

  // Allow registered project paths (and their subtrees) and ancestor directories
  const projects = pm.listProjects();
  for (const project of projects) {
    const projectPath = normalize(resolve(project.path));
    // Target is inside or equal to a project path
    if (normalizedTarget.startsWith(projectPath)) return true;
    // Target is an ancestor of a project path (e.g. browsing C:\ to reach C:\Users\x\project)
    if (projectPath.startsWith(normalizedTarget)) return true;
  }

  return false;
}

/** Throw 403 if path is not in an allowed directory */
function requireAllowedPath(path: string): void {
  if (!isPathAllowed(path)) {
    throw Forbidden('Access denied: path is outside allowed directories');
  }
}

/** Require a non-empty string from a query param or body field, throw 400 if missing */
function requirePath(value: string | undefined, label = 'path'): string {
  if (!value) throw BadRequest(`${label} is required`);
  return value;
}

// List drives (Windows) or root dirs
app.get('/roots', (c) => {
  try {
    // On Windows, list available drive letters
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
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// List subdirectories of a given path
app.get('/list', (c) => {
  const dirPath = requirePath(c.req.query('path'), 'path query parameter');
  requireAllowedPath(dirPath);

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter((e) => {
        if (!e.isDirectory()) return false;
        // Skip hidden/system folders
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '$Recycle.Bin' || e.name === 'System Volume Information') return false;
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
  } catch (error: any) {
    const parsed = parsePath(dirPath);
    const parent = parsed.dir || null;
    return c.json({ path: dirPath, parent, dirs: [], error: error.message });
  }
});

// Get git repo name from remote origin for a given path
app.get('/repo-name', async (c) => {
  const dirPath = requirePath(c.req.query('path'), 'path query parameter');
  requireAllowedPath(dirPath);

  try {
    const remoteUrl = await getRemoteUrl(dirPath);

    if (remoteUrl) {
      const name = extractRepoName(remoteUrl);
      return c.json({ name });
    }

    // No remote — fall back to folder name
    const folderName = dirPath.split(/[\\/]/).filter(Boolean).pop() || '';
    return c.json({ name: folderName });
  } catch {
    // Not a git repo or error — fall back to folder name
    const folderName = dirPath.split(/[\\/]/).filter(Boolean).pop() || '';
    return c.json({ name: folderName });
  }
});

// Initialize a git repo at the given path
app.post('/git-init', async (c) => {
  const { path: dirPath } = await c.req.json<{ path: string }>();
  requirePath(dirPath, 'path');
  requireAllowedPath(dirPath);

  await initRepo(dirPath);
  return c.json({ ok: true });
});

// Open directory in file explorer
app.post('/open-directory', async (c) => {
  const { path: dirPath } = await c.req.json<{ path: string }>();
  requirePath(dirPath, 'path');
  requireAllowedPath(dirPath);

  const os = platform();
  let cmd: string;
  let args: string[];

  if (os === 'win32') {
    cmd = 'explorer';
    args = [dirPath.replace(/\//g, '\\')];
  } else if (os === 'darwin') {
    cmd = 'open';
    args = [dirPath];
  } else {
    cmd = 'xdg-open';
    args = [dirPath];
  }

  Bun.spawn([cmd, ...args], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  return c.json({ ok: true });
});

// Open terminal at directory
app.post('/open-terminal', async (c) => {
  const { path: dirPath } = await c.req.json<{ path: string }>();
  requirePath(dirPath, 'path');
  requireAllowedPath(dirPath);

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

export default app;
