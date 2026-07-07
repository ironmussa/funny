import { performance } from 'node:perf_hooks';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { markdownToHtml } from 'satteri';

interface CliOptions {
  iterations: number;
  warmup: number;
  messages: number;
}

interface BenchResult {
  name: string;
  meanMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  messagesPerSecond: number;
  checksum: number;
  bytes: number;
}

const reactMarkdownElement = React.createElement;
const rehypePlugins = [rehypeSanitize];
const remarkPlugins = [remarkGfm];

function optionValue(flag: string): string | null {
  const prefix = `${flag}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function positiveInteger(flag: string, fallback: number): number {
  const raw = optionValue(flag);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCliOptions(): CliOptions {
  return {
    iterations: positiveInteger('--iterations', 30),
    warmup: positiveInteger('--warmup', 5),
    messages: positiveInteger('--messages', 50),
  };
}

function makeMessage(index: number): string {
  const file = `/home/u/projects/funny/packages/client/src/components/thread/MessageContent.tsx:${80 + index}`;
  return [
    `## Agent update ${index}`,
    '',
    'Here is a mixed Markdown response with **bold text**, `inline code`, a local file link, and GFM.',
    '',
    `Open [MessageContent.tsx](${file}) and compare [the PR](https://github.com/acme/repo/pull/${index}).`,
    '',
    '- [x] Preserve sanitized rendering',
    '- [ ] Keep task-list checkboxes readable',
    '- [ ] Avoid breaking file links',
    '',
    '| Area | Current | Candidate |',
    '| --- | ---: | ---: |',
    `| Parse ${index} | react-markdown | satteri |`,
    '| Render | React components | HTML string |',
    '',
    '```ts',
    'type ThreadMessage = {',
    '  id: string;',
    '  role: "user" | "assistant";',
    '  content: string;',
    '};',
    '',
    'export function summarize(messages: ThreadMessage[]) {',
    '  return messages.map((message) => message.content.trim()).join("\\n\\n");',
    '}',
    '```',
    '',
    '> Raw HTML should be escaped or sanitized: <img src=x onerror="alert(1)">',
    '',
    'Final paragraph with enough text to resemble a real coding-agent answer. '.repeat(8),
  ].join('\n');
}

function makeCorpus(messageCount: number): string[] {
  return Array.from({ length: messageCount }, (_, index) => makeMessage(index + 1));
}

function renderReactMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    reactMarkdownElement(ReactMarkdown, {
      remarkPlugins,
      rehypePlugins,
      children: markdown,
    }),
  );
}

function renderSatteri(markdown: string): string {
  return markdownToHtml(markdown, {
    features: { gfm: true },
  }).html;
}

function checksum(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function runBench(
  name: string,
  render: (markdown: string) => string,
  corpus: string[],
  options: CliOptions,
): BenchResult {
  for (let i = 0; i < options.warmup; i++) {
    for (const markdown of corpus) render(markdown);
  }

  const samples: number[] = [];
  let totalBytes = 0;
  let combinedChecksum = 2166136261;
  for (let i = 0; i < options.iterations; i++) {
    const start = performance.now();
    let iterationBytes = 0;
    let iterationChecksum = 0;
    for (const markdown of corpus) {
      const html = render(markdown);
      iterationBytes += html.length;
      iterationChecksum = (iterationChecksum ^ checksum(html)) >>> 0;
    }
    samples.push(performance.now() - start);
    totalBytes = iterationBytes;
    combinedChecksum = Math.imul(combinedChecksum ^ iterationChecksum, 16777619) >>> 0;
  }

  const totalMs = samples.reduce((sum, sample) => sum + sample, 0);
  const meanMs = totalMs / samples.length;
  return {
    name,
    meanMs,
    p95Ms: percentile(samples, 95),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    messagesPerSecond: corpus.length / (meanMs / 1000),
    checksum: combinedChecksum,
    bytes: totalBytes,
  };
}

function hasExecutableRawHtml(html: string): boolean {
  return /<img\b[^>]*\bonerror=/.test(html);
}

function printCompatibilityNotes(): void {
  const rawHtmlProbe = 'Raw <img src=x onerror="alert(1)">';
  const reactMarkdownHtml = renderReactMarkdown(rawHtmlProbe);
  const satteriHtml = renderSatteri(rawHtmlProbe);

  console.log('Compatibility notes:');
  console.log(
    `- raw HTML probe: react-markdown executable=${hasExecutableRawHtml(reactMarkdownHtml)}, satteri executable=${hasExecutableRawHtml(satteriHtml)}`,
  );
  if (hasExecutableRawHtml(satteriHtml)) {
    console.log(
      '- Satteri preserves raw HTML in this path; a migration still needs an explicit sanitizer or HTML policy.',
    );
  }
}

function printResult(result: BenchResult): void {
  console.log(
    [
      result.name.padEnd(16),
      `mean=${result.meanMs.toFixed(2)}ms`,
      `p95=${result.p95Ms.toFixed(2)}ms`,
      `min=${result.minMs.toFixed(2)}ms`,
      `max=${result.maxMs.toFixed(2)}ms`,
      `throughput=${result.messagesPerSecond.toFixed(0)} msg/s`,
      `bytes=${result.bytes}`,
      `checksum=${result.checksum}`,
    ].join('  '),
  );
}

const options = parseCliOptions();
const corpus = makeCorpus(options.messages);

console.log(
  `Markdown renderer benchmark: messages=${options.messages}, iterations=${options.iterations}, warmup=${options.warmup}`,
);
console.log(
  'Note: react-markdown path includes React static render + rehype-sanitize; Satteri path emits HTML only.',
);

const reactMarkdownResult = runBench('react-markdown', renderReactMarkdown, corpus, options);
const satteriResult = runBench('satteri', renderSatteri, corpus, options);
const speedup = reactMarkdownResult.meanMs / satteriResult.meanMs;

printResult(reactMarkdownResult);
printResult(satteriResult);
console.log(`Satteri mean speedup: ${speedup.toFixed(2)}x`);
printCompatibilityNotes();
