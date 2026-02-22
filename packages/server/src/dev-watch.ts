/**
 * Dev wrapper: runs `bun --watch src/index.ts` and also watches sibling
 * workspace packages (core, shared) that bun --watch cannot see.
 *
 * Instead of killing and restarting the bun process (which orphans agent
 * subprocesses on Windows), we `touch` the entry point so that bun --watch
 * performs its own graceful restart via the globalThis.__bunServer pattern.
 */
import { watch, type FSWatcher, utimesSync } from 'fs';
import { resolve } from 'path';
import { existsSync } from 'fs';

const serverDir = resolve(import.meta.dir, '..');
const entryPoint = resolve(serverDir, 'src', 'index.ts');
const extraWatchDirs = [
  resolve(serverDir, '..', 'core', 'src'),
  resolve(serverDir, '..', 'shared', 'src'),
];

let child: ReturnType<typeof Bun.spawn> | null = null;

function startServer() {
  child = Bun.spawn(['bun', '--watch', 'src/index.ts'], {
    cwd: serverDir,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env },
  });

  child.exited.then((code) => {
    process.exit(code ?? 0);
  });
}

/**
 * Touch the entry point to trigger bun --watch's native reload.
 * This lets bun handle the restart gracefully — the shutdown handler runs,
 * agents are stopped cleanly, and the DB is closed properly.
 */
function triggerReload() {
  console.log('[dev-watch] Sibling package changed — triggering reload...');
  try {
    const now = new Date();
    utimesSync(entryPoint, now, now);
  } catch (err) {
    console.warn('[dev-watch] Failed to touch entry point:', err);
  }
}

// Debounce: collect rapid changes into a single reload
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function onSiblingChange(_event: string, filename: string | null) {
  if (filename && !filename.endsWith('.ts') && !filename.endsWith('.tsx')) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(triggerReload, 500);
}

// Watch sibling packages recursively
const watchers: FSWatcher[] = [];
for (const dir of extraWatchDirs) {
  if (!existsSync(dir)) {
    console.log(`[dev-watch] Skipping ${dir} (not found)`);
    continue;
  }
  console.log(`[dev-watch] Watching ${dir}`);
  watchers.push(watch(dir, { recursive: true }, onSiblingChange));
}

// Clean up on exit
function cleanup() {
  for (const w of watchers) w.close();
  if (debounceTimer) clearTimeout(debounceTimer);
  if (child?.pid) {
    if (process.platform === 'win32') {
      // On Windows, child.kill() calls TerminateProcess which kills ONLY the
      // target process — child processes (PTY helper, etc.) survive and can hold
      // the server's port open. Use taskkill /T to kill the entire process tree.
      try {
        Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${child.pid}`]);
      } catch {}
    } else {
      child.kill();
    }
  }
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Run kill-port first, then start server
await import('./kill-port.js');
startServer();
