import { relative, resolve } from 'node:path';

import { chromium, type CDPSession } from 'playwright';

type Viewer = 'virtual' | 'frozen';

interface ThreadProfileSnapshot {
  viewer: Viewer;
  markdownRenderer: 'satteri';
  messageCount: number;
  initialRowCount: number;
}

const clientDir = resolve(import.meta.dir, '../packages/client');
const outputDir = `/tmp/funny-client-profile-${process.pid}`;

function optionValue(flag: string): string | null {
  const prefix = `${flag}=`;
  const option = process.argv.find((arg) => arg.startsWith(prefix));
  return option ? option.slice(prefix.length) : null;
}

function viewerFromOptions(): Viewer {
  const viewer = optionValue('--viewer') ?? 'virtual';
  if (viewer === 'virtual' || viewer === 'frozen') return viewer;
  throw new Error(`Unknown viewer ${viewer}; use --viewer=virtual or --viewer=frozen`);
}

function contentType(pathname: string): string {
  if (pathname.endsWith('.html')) return 'text/html; charset=utf-8';
  if (pathname.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
  if (pathname.endsWith('.wasm')) return 'application/wasm';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.woff') || pathname.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !path.includes('/..');
}

async function buildProfiler(): Promise<void> {
  const build = Bun.spawn({
    cmd: [
      'bun',
      'x',
      'vite',
      'build',
      '--outDir',
      outputDir,
      '--emptyOutDir',
      '--logLevel',
      'error',
    ],
    cwd: clientDir,
    env: { ...process.env, VITE_BENCHMARK_TARGET: 'thread' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) throw new Error(`Vite profiler build exited with ${exitCode}`);
}

function serveBuild(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const resolvedPath = resolve(outputDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!isInside(outputDir, resolvedPath)) return new Response('Not found', { status: 404 });

      const file = Bun.file(resolvedPath);
      if (!(await file.exists())) return new Response('Not found', { status: 404 });
      return new Response(file, { headers: { 'content-type': contentType(resolvedPath) } });
    },
  });
}

async function removeOutput(): Promise<void> {
  const remove = Bun.spawn({ cmd: ['rm', '-rf', outputDir], stdout: 'ignore', stderr: 'ignore' });
  await remove.exited;
}

async function captureSnapshot(cdp: CDPSession) {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  return {
    heap: await cdp.send('Runtime.getHeapUsage'),
    dom: await cdp.send('Memory.getDOMCounters'),
  };
}

const viewer = viewerFromOptions();
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await buildProfiler();
  server = serveBuild();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cdp = await page.context().newCDPSession(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await cdp.send('Performance.enable');
  await page.goto(`http://127.0.0.1:${server.port}/benchmark/thread-viewer.html?viewer=${viewer}`, {
    waitUntil: 'networkidle',
  });
  try {
    await page.waitForFunction(() => Boolean(window.funnyThreadProfile), undefined, {
      timeout: 10_000,
    });
  } catch (error) {
    const status = await page.locator('#profile-status').textContent();
    throw new Error(
      `Thread profile fixture did not become ready (${status ?? 'no status'}; page errors: ${errors.join('; ') || 'none'}): ${String(error)}`,
      { cause: error },
    );
  }
  if (errors.length > 0) throw new Error(`Browser profiler errors: ${errors.join('; ')}`);

  const before = await captureSnapshot(cdp);
  const profile = await page.evaluate(
    () =>
      ({
        viewer: window.funnyThreadProfile!.viewer,
        markdownRenderer: window.funnyThreadProfile!.markdownRenderer,
        messageCount: window.funnyThreadProfile!.messageCount,
        initialRowCount: window.funnyThreadProfile!.initialRowCount,
      }) as ThreadProfileSnapshot,
  );
  const scrollSweep = await page.evaluate(() => window.funnyThreadProfile!.scrollSweep());
  const threadSwitchMs = await page.evaluate(() => window.funnyThreadProfile!.switchThread());
  const after = {
    ...(await captureSnapshot(cdp)),
    performance: await cdp.send('Performance.getMetrics'),
  };

  console.log(
    JSON.stringify(
      {
        viewer: profile.viewer,
        markdownRenderer: profile.markdownRenderer,
        fixture: { messages: profile.messageCount, initialRows: profile.initialRowCount },
        heap: { before: before.heap, after: after.heap },
        dom: { before: before.dom, after: after.dom },
        scrollFrames: scrollSweep,
        threadSwitchMs,
        performance: after.performance,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server?.stop(true);
  await removeOutput();
}
