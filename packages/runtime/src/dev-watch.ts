/**
 * Dev wrapper: runs `bun src/index.ts` and restarts on file changes.
 *
 * On Windows, `bun --watch` forks worker processes — each with its own
 * globalThis. When the worker is replaced, its child processes (agents, PTY
 * helpers, etc.) survive and inherit the server's socket handle, creating
 * ghost sockets that intercept new connections. This prevents the UI from
 * reconnecting after a reload.
 *
 * To fix this, we manage the server process lifecycle ourselves:
 *   1. Spawn `bun src/index.ts` (no --watch)
 *   2. Watch source files for changes (server + sibling packages)
 *   3. On change, kill the ENTIRE process tree (taskkill /F /T on Windows)
 *   4. Run kill-port to clean any remaining ghost sockets
 *   5. Respawn the server
 */
import { watch, type FSWatcher, existsSync } from 'fs';
import { resolve } from 'path';

const serverDir = resolve(import.meta.dir, '..');
const srcDir = resolve(serverDir, 'src');
const extraWatchDirs = [
  resolve(serverDir, '..', 'core', 'src'),
  resolve(serverDir, '..', 'shared', 'src'),
];

let child: ReturnType<typeof Bun.spawn> | null = null;
let restarting = false;
let exitRequested = false;

function startServer() {
  const server = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: serverDir,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env },
  });
  child = server;

  void server.exited.then((code) => {
    // A previous child can finish after its replacement has started. It must
    // not clear or restart the replacement, or later reloads lose track of it
    // and leave duplicate runtimes connected to the same runner.
    if (child !== server) return;
    child = null;
    if (!exitRequested && !restarting) {
      // Server crashed — restart after a short delay
      console.log(`[dev-watch] Server exited with code ${code}, restarting in 1s...`);
      setTimeout(startServer, 1000);
    }
  });
}

async function killServer(): Promise<void> {
  const server = child;
  if (!server?.pid) return;
  const pid = server.pid;

  if (process.platform === 'win32') {
    // Kill the entire process tree — prevents ghost sockets from
    // inherited handles in child processes (agents, PTY, etc.)
    try {
      Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${pid}`]);
    } catch {}
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {}
    try {
      server.kill();
    } catch {}
  }

  await Promise.race([server.exited, Bun.sleep(3000)]);
  if (child === server) child = null;
}

async function restart() {
  if (restarting) return;
  restarting = true;

  console.log('[dev-watch] File changed — restarting server...');
  await killServer();

  // On Windows, run kill-port to clean any ghost sockets left by
  // inherited handles that survived the tree kill.
  if (process.platform === 'win32') {
    try {
      await import('./kill-port.js');
    } catch {}
  }

  startServer();
  restarting = false;
}

// Debounce: collect rapid changes into a single restart
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function onFileChange(_event: string, filename: string | null) {
  if (filename && !filename.endsWith('.ts') && !filename.endsWith('.tsx')) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void restart(), 300);
}

// Watch server source + sibling packages
const watchers: FSWatcher[] = [];

// Watch server/src
console.log(`[dev-watch] Watching ${srcDir}`);
watchers.push(watch(srcDir, { recursive: true }, onFileChange));

// Watch sibling packages
for (const dir of extraWatchDirs) {
  if (!existsSync(dir)) {
    console.log(`[dev-watch] Skipping ${dir} (not found)`);
    continue;
  }
  console.log(`[dev-watch] Watching ${dir}`);
  watchers.push(watch(dir, { recursive: true }, onFileChange));
}

// Clean up on exit
async function cleanup() {
  exitRequested = true;
  for (const w of watchers) w.close();
  if (debounceTimer) clearTimeout(debounceTimer);
  await killServer();
  process.exit(0);
}
process.on('SIGINT', () => void cleanup());
process.on('SIGTERM', () => void cleanup());

// Run kill-port first, then start server
await import('./kill-port.js');
startServer();
