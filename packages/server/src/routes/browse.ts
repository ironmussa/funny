import { Hono } from 'hono';
import { readdirSync } from 'fs';
import { join, parse as parsePath, resolve, normalize } from 'path';
import { homedir, platform } from 'os';
import { getRemoteUrl, extractRepoName, initRepo } from '../utils/git-v2.js';
import * as pm from '../services/project-manager.js';
import { resultToResponse } from '../utils/result-response.js';

const app = new Hono();

/**
 * Check if a path is within an allowed directory.
 */
function isPathAllowed(targetPath: string): boolean {
  const normalizedTarget = normalize(resolve(targetPath));

  const home = normalize(resolve(homedir()));
  if (normalizedTarget.startsWith(home)) return true;

  const projects = pm.listProjects();
  for (const project of projects) {
    const projectPath = normalize(resolve(project.path));
    if (normalizedTarget.startsWith(projectPath)) return true;
    if (projectPath.startsWith(normalizedTarget)) return true;
  }

  return false;
}

/** Return 403 response if path is not in an allowed directory */
function checkAllowedPath(path: string): Response | null {
  if (!isPathAllowed(path)) {
    return new Response(JSON.stringify({ error: 'Access denied: path is outside allowed directories' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
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
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// List subdirectories of a given path
app.get('/list', (c) => {
  const dirPathOrRes = checkRequired(c.req.query('path'), 'path query parameter');
  if (dirPathOrRes instanceof Response) return dirPathOrRes;
  const dirPath = dirPathOrRes;

  const denied = checkAllowedPath(dirPath);
  if (denied) return denied;

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter((e) => {
        if (!e.isDirectory()) return false;
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
  const dirPathOrRes = checkRequired(c.req.query('path'), 'path query parameter');
  if (dirPathOrRes instanceof Response) return dirPathOrRes;
  const dirPath = dirPathOrRes;

  const denied = checkAllowedPath(dirPath);
  if (denied) return denied;

  const remoteResult = await getRemoteUrl(dirPath);
  if (remoteResult.isOk() && remoteResult.value) {
    const name = extractRepoName(remoteResult.value);
    return c.json({ name });
  }

  const folderName = dirPath.split(/[\\/]/).filter(Boolean).pop() || '';
  return c.json({ name: folderName });
});

// Initialize a git repo at the given path
app.post('/git-init', async (c) => {
  const { path: dirPath } = await c.req.json<{ path: string }>();
  if (!dirPath) return c.json({ error: 'path is required' }, 400);

  const denied = checkAllowedPath(dirPath);
  if (denied) return denied;

  const result = await initRepo(dirPath);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// Open directory in file explorer
app.post('/open-directory', async (c) => {
  const { path: dirPath } = await c.req.json<{ path: string }>();
  if (!dirPath) return c.json({ error: 'path is required' }, 400);

  const denied = checkAllowedPath(dirPath);
  if (denied) return denied;

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
  if (!dirPath) return c.json({ error: 'path is required' }, 400);

  const denied = checkAllowedPath(dirPath);
  if (denied) return denied;

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
