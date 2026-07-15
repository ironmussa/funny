import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { chromium } from 'playwright';

interface RendererBenchmarkResult {
  name: string;
  meanMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  messagesPerSecond: number;
  renderedHtmlBytes: number;
}

interface MarkdownWasmBenchmarkResult {
  corpusMessages: number;
  iterations: number;
  satteriWasm: RendererBenchmarkResult;
}

const clientDir = resolve(import.meta.dir, '..');
const outputDir = `/tmp/funny-markdown-wasm-benchmark-${process.pid}`;

function contentType(pathname: string): string {
  if (pathname.endsWith('.html')) return 'text/html; charset=utf-8';
  if (pathname.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
  if (pathname.endsWith('.wasm')) return 'application/wasm';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !path.includes('/..');
}

async function runBuild(): Promise<void> {
  const build = Bun.spawn({
    cmd: ['bun', 'x', 'vite', 'build', '--outDir', outputDir, '--emptyOutDir'],
    cwd: clientDir,
    env: { ...process.env, VITE_BENCHMARK_TARGET: 'markdown' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) throw new Error(`Vite benchmark build exited with ${exitCode}`);
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

async function findWasmSize(): Promise<{ file: string; rawBytes: number; gzipBytes: number }> {
  const wasmFiles = Array.from(new Bun.Glob('**/*.wasm').scanSync({ cwd: outputDir }));
  const satteriWasm = wasmFiles.find((file) => file.includes('satteri'));
  if (!satteriWasm) {
    throw new Error(
      `No Sätteri WASM asset emitted by Vite. Found: ${wasmFiles.join(', ') || 'none'}`,
    );
  }

  const bytes = new Uint8Array(await Bun.file(join(outputDir, satteriWasm)).arrayBuffer());
  return {
    file: satteriWasm,
    rawBytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes).byteLength,
  };
}

async function removeOutput(): Promise<void> {
  const remove = Bun.spawn({ cmd: ['rm', '-rf', outputDir], stdout: 'ignore', stderr: 'ignore' });
  await remove.exited;
}

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await runBuild();
  const wasm = await findWasmSize();
  server = serveBuild();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(
    `http://127.0.0.1:${server.port}/benchmark/markdown-wasm.html?messages=100&iterations=20&warmup=4`,
    { waitUntil: 'networkidle' },
  );
  await page.waitForFunction(() => Boolean(window.__FUNNY_MARKDOWN_WASM_BENCHMARK__));
  if (errors.length > 0) throw new Error(`Browser benchmark errors: ${errors.join('; ')}`);

  const result = await page.evaluate(
    () => window.__FUNNY_MARKDOWN_WASM_BENCHMARK__ as MarkdownWasmBenchmarkResult,
  );
  console.log(
    JSON.stringify(
      {
        benchmark: result,
        wasm,
        notes: [
          'Measurements include parsing, sanitization, DOM insertion, and a forced layout.',
          'Each sample waits for a paint after timing so a subsequent iteration cannot overlap rendering.',
          'The Sätteri path also includes DOMPurify sanitization.',
        ],
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
