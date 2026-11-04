/**
 * `$BROWSER` bridge: URLs opened by commands the agent runs (OAuth logins like
 * `wrangler login`, `gh auth login --web`, docs links) load in the thread's
 * browser session — shown in the Browser Panel — instead of a system browser
 * the headless runner does not have.
 *
 * Agent processes get `BROWSER=<shim>` plus the thread id and a per-user drop
 * directory. The shim writes one small file per URL; the runner watches the
 * directory and opens each URL in that thread's session. `xdg-open` honours
 * `$BROWSER` when no desktop environment is detected, so CLIs that shell out to
 * it are covered too. The directory is per user and `0700`: only processes of
 * the runner's OS user can drop requests, the same trust boundary as the
 * runner itself, and the thread must still belong to that user.
 */

import { watch, type FSWatcher } from 'fs';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import { DATA_DIR } from '../../lib/data-dir.js';
import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';

const NS = 'browser-open-url';

const SHIM = `#!/bin/sh
# Funny: open URLs in this thread's browser session (Browser Panel).
dir="\${FUNNY_BROWSER_OPEN_DIR:?FUNNY_BROWSER_OPEN_DIR is not set}"
thread="\${FUNNY_THREAD_ID:?FUNNY_THREAD_ID is not set}"
for url in "$@"; do
  f="$dir/$(date +%s%N)-$$.url"
  printf '%s\\n%s\\n' "$thread" "$url" > "$f.tmp" && mv "$f.tmp" "$f"
  echo "Opened in the Funny browser panel: $url"
done
`;

const shimPath = join(DATA_DIR, 'bin', 'funny-open-url');
let shimReady: Promise<void> | null = null;
const watchers = new Map<string, FSWatcher>();

function safeSegment(userId: string): string {
  return userId.replace(/[^A-Za-z0-9_-]/g, '_') || 'anonymous';
}

function dropDirFor(userId: string): string {
  return join(DATA_DIR, 'browser-open', safeSegment(userId));
}

function ensureShim(): Promise<void> {
  shimReady ??= (async () => {
    await mkdir(join(DATA_DIR, 'bin'), { recursive: true });
    await writeFile(shimPath, SHIM, { mode: 0o755 });
    await chmod(shimPath, 0o755);
  })();
  return shimReady;
}

/** Parse a drop file: first line thread id, second line URL. */
export function parseDropFile(content: string): { threadId: string; url: string } | null {
  const [threadId, url] = content.split('\n').map((l) => l.trim());
  return threadId && url ? { threadId, url } : null;
}

async function handleDrop(userId: string, file: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return; // Already handled (watch events can repeat).
  }
  await rm(file, { force: true });
  const request = parseDropFile(content);
  if (!request) return;

  const { getThread } = await import('../thread-manager.js');
  const thread = await getThread(request.threadId);
  if (!thread || thread.userId !== userId) {
    log.warn('Ignoring open-url request for a thread the user does not own', {
      namespace: NS,
      threadId: request.threadId,
    });
    return;
  }
  const { normalizeUrl } = await import('./browser-tools.js');
  const { browserSessionManager } = await import('../browser-session-manager.js');
  try {
    const url = normalizeUrl(request.url);
    await browserSessionManager.openForThread(userId, request.threadId, url);
    metric('browser_open_url.opened', 1, { type: 'sum' });
    log.info('Opened URL from agent process', { namespace: NS, threadId: request.threadId });
  } catch (err) {
    log.warn('Could not open URL from agent process', {
      namespace: NS,
      threadId: request.threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function drain(userId: string, dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    entries.filter((e) => e.endsWith('.url')).map((e) => handleDrop(userId, join(dir, e))),
  );
}

async function ensureWatcher(userId: string, dir: string): Promise<void> {
  if (watchers.has(userId)) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const watcher = watch(dir, (_event, name) => {
    if (name && String(name).endsWith('.url')) void handleDrop(userId, join(dir, String(name)));
  });
  watcher.on('error', (err) => {
    log.warn('open-url watcher failed', { namespace: NS, error: String(err) });
    watchers.delete(userId);
  });
  watcher.unref?.();
  watchers.set(userId, watcher);
  await drain(userId, dir);
}

/**
 * Environment for an agent spawn so `$BROWSER` opens URLs in the thread's
 * browser session. Empty when disabled (`FUNNY_BROWSER_TOOLS=0`) or on failure.
 */
export async function browserOpenEnv(
  userId: string,
  threadId: string,
): Promise<Record<string, string>> {
  if (process.env.FUNNY_BROWSER_TOOLS === '0') return {};
  const dir = dropDirFor(userId);
  try {
    await ensureShim();
    await ensureWatcher(userId, dir);
  } catch (err) {
    log.warn('Could not prepare $BROWSER bridge', { namespace: NS, error: String(err) });
    return {};
  }
  return { BROWSER: shimPath, FUNNY_THREAD_ID: threadId, FUNNY_BROWSER_OPEN_DIR: dir };
}

/** Stop all watchers (runner shutdown / tests). */
export function closeOpenUrlWatchers(): void {
  for (const w of watchers.values()) w.close();
  watchers.clear();
}
