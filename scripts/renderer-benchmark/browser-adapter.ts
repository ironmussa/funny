import { relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { chromium } from 'playwright';

import {
  encodeBenchmarkMessage,
  parseBenchmarkCommand,
  type BenchmarkCommand,
  type BenchmarkEvent,
} from '../../packages/client-benchmark/src/index';

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv
    .find((candidate) => candidate.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) throw new Error(`Missing required ${prefix}<value> argument`);
  return value;
}

function contentType(pathname: string): string {
  if (pathname.endsWith('.html')) return 'text/html; charset=utf-8';
  if (pathname.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
  if (pathname.endsWith('.wasm')) return 'application/wasm';
  if (pathname.endsWith('.woff') || pathname.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !path.includes('/..');
}

const buildDirectory = resolve(argument('build-dir'));
const viewer = argument('viewer');
if (viewer !== 'virtual' && viewer !== 'frozen') throw new Error(`Unsupported viewer ${viewer}`);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const resolvedPath = resolve(
      buildDirectory,
      `.${pathname === '/' ? '/thread-viewer.html' : pathname}`,
    );
    if (!isInside(buildDirectory, resolvedPath)) return new Response('Not found', { status: 404 });
    const file = Bun.file(resolvedPath);
    if (!(await file.exists())) return new Response('Not found', { status: 404 });
    return new Response(file, { headers: { 'content-type': contentType(resolvedPath) } });
  },
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://127.0.0.1:${server.port}/benchmark/thread-viewer.html?viewer=${viewer}`, {
  waitUntil: 'networkidle',
});
await page.waitForFunction(
  () => document.getElementById('profile-status')?.textContent?.startsWith('Ready') === true,
  undefined,
  { timeout: 20_000 },
);

function writeEvents(events: BenchmarkEvent[]): void {
  for (const event of events) process.stdout.write(encodeBenchmarkMessage(event));
}

async function handle(command: BenchmarkCommand): Promise<void> {
  const events = await page.evaluate(async (value) => {
    const benchmarkWindow = window as typeof window & {
      funnyThreadProfile?: {
        handleCommand: (input: BenchmarkCommand) => Promise<BenchmarkEvent[]>;
      };
    };
    return benchmarkWindow.funnyThreadProfile?.handleCommand(value) ?? [];
  }, command);
  writeEvents(events);
  if (command.type === 'shutdown') {
    await browser.close();
    server.stop(true);
    process.stdout.write('', () => process.exit(0));
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
let pending = Promise.resolve();
lines.on('line', (line) => {
  pending = pending.then(async () => {
    try {
      await handle(parseBenchmarkCommand(line));
    } catch (error) {
      writeEvents([
        {
          type: 'error',
          code: 'browser-adapter-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      ]);
    }
  });
});
