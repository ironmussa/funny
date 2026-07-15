import DOMPurify from 'dompurify';
import { markdownToHtml } from 'satteri';

import { makeLongThread } from '../test-fixtures/long-thread-fixture';

interface BenchmarkOptions {
  iterations: number;
  warmup: number;
  messageCount: number;
}

interface RendererBenchmarkResult {
  name: 'satteri-wasm';
  meanMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  messagesPerSecond: number;
  renderedHtmlBytes: number;
}

export interface MarkdownWasmBenchmarkResult {
  corpusMessages: number;
  iterations: number;
  satteriWasm: RendererBenchmarkResult;
}

declare global {
  interface Window {
    __FUNNY_MARKDOWN_WASM_BENCHMARK__?: MarkdownWasmBenchmarkResult;
  }
}

const satteriTarget = requiredElement('satteri-target');

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing benchmark target #${id}`);
  return element;
}

function optionFromQuery(name: string, fallback: number): number {
  const raw = new URLSearchParams(window.location.search).get(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function renderSatteriWasm(corpus: string[]): string {
  satteriTarget.innerHTML = corpus
    .map((markdown) =>
      DOMPurify.sanitize(markdownToHtml(markdown, { features: { gfm: true } }).html),
    )
    .join('\n');
  return satteriTarget.innerHTML;
}

async function runRenderer(
  name: RendererBenchmarkResult['name'],
  render: (corpus: string[]) => string,
  corpus: string[],
  options: BenchmarkOptions,
): Promise<RendererBenchmarkResult> {
  for (let iteration = 0; iteration < options.warmup; iteration++) {
    render(corpus);
    await nextPaint();
  }

  const samples: number[] = [];
  let renderedHtmlBytes = 0;
  for (let iteration = 0; iteration < options.iterations; iteration++) {
    const start = performance.now();
    const html = render(corpus);
    // Force layout and wait for a paint: the measurement includes DOM insertion,
    // not only parsing or React reconciliation.
    void satteriTarget.getBoundingClientRect();
    samples.push(performance.now() - start);
    await nextPaint();
    renderedHtmlBytes = new TextEncoder().encode(html).byteLength;
  }

  const meanMs = samples.reduce((total, value) => total + value, 0) / samples.length;
  return {
    name,
    meanMs,
    p95Ms: percentile(samples, 95),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    messagesPerSecond: corpus.length / (meanMs / 1000),
    renderedHtmlBytes,
  };
}

export async function runMarkdownWasmBenchmark(
  options: Partial<BenchmarkOptions> = {},
): Promise<MarkdownWasmBenchmarkResult> {
  const resolvedOptions: BenchmarkOptions = {
    iterations: options.iterations ?? optionFromQuery('iterations', 20),
    warmup: options.warmup ?? optionFromQuery('warmup', 4),
    messageCount: options.messageCount ?? optionFromQuery('messages', 100),
  };
  const corpus = makeLongThread({ messageCount: resolvedOptions.messageCount }).markdownCorpus;
  const satteriWasm = await runRenderer('satteri-wasm', renderSatteriWasm, corpus, resolvedOptions);

  return {
    corpusMessages: corpus.length,
    iterations: resolvedOptions.iterations,
    satteriWasm,
  };
}

void runMarkdownWasmBenchmark().then((result) => {
  window.__FUNNY_MARKDOWN_WASM_BENCHMARK__ = result;
  const resultElement = requiredElement('result');
  resultElement.textContent = JSON.stringify(result, null, 2);
});
