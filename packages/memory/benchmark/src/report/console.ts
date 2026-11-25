import type { BenchmarkMetrics } from '../types.js';

interface ComparisonTarget {
  accuracy: number;
  source: string;
}

/** Published comparison targets from other systems */
const COMPARISON_TARGETS = {
  LOCOMO: {
    Mem0: { accuracy: 0.6713, source: 'ArXiv 2504.19413' },
    'Zep (Mem0 paper)': { accuracy: 0.6599, source: 'ArXiv 2504.19413' },
    'Zep (self-reported)': { accuracy: 0.7514, source: 'Zep blog' },
    LangMem: { accuracy: 0.581, source: 'ArXiv 2504.19413' },
  },
  LongMemEval: {
    Hindsight: { accuracy: 0.914, source: 'Hindsight paper' },
    'Full-context GPT-4o': { accuracy: 0.7, source: 'LongMemEval paper' },
  },
} satisfies Record<string, Record<string, ComparisonTarget>>;

export function printReport(metrics: BenchmarkMetrics): void {
  const line = '─'.repeat(60);

  console.log(`\n${line}`);
  console.log(`  BENCHMARK RESULTS: ${metrics.benchmark}`);
  console.log(line);

  // Overall stats
  console.log(`  Model:           ${metrics.model}`);
  console.log(`  Recall limit:    ${metrics.recallLimit}`);
  console.log(`  Duration:        ${formatDuration(metrics.durationSeconds)}`);
  console.log(`  Facts created:   ${metrics.totalFactsCreated}`);
  console.log(`  Facts (dedup):   ${metrics.totalFactsAfterDedup}`);
  console.log(`  DB size:         ${formatBytes(metrics.dbSizeBytes)}`);
  console.log(`  Total tokens:    ${metrics.totalTokensUsed.toLocaleString()}`);

  // Accuracy
  console.log(`\n  ACCURACY`);
  console.log(`  ${'-'.repeat(56)}`);
  console.log(
    `  Overall:         ${(metrics.overallAccuracy * 100).toFixed(2)}% ` +
      `(${metrics.totalCorrect}/${metrics.totalQuestions})`,
  );

  // Category breakdown
  if (metrics.categoryBreakdown.length > 0) {
    console.log(`\n  Per-category:`);
    const maxCatLen = Math.max(...metrics.categoryBreakdown.map((c) => c.category.length));

    for (const cat of metrics.categoryBreakdown) {
      const name = cat.category.padEnd(maxCatLen);
      const pct = (cat.accuracy * 100).toFixed(2).padStart(6);
      const bar = progressBar(cat.accuracy, 20);
      console.log(`    ${name}  ${pct}%  ${bar}  (${cat.correct}/${cat.total})`);
    }
  }

  // Latency
  console.log(`\n  LATENCY`);
  console.log(`  ${'-'.repeat(56)}`);
  console.log(`  Mean:    ${metrics.latency.mean}ms`);
  console.log(`  P50:     ${metrics.latency.p50}ms`);
  console.log(`  P95:     ${metrics.latency.p95}ms`);
  console.log(`  P99:     ${metrics.latency.p99}ms`);

  // Comparison table
  const benchKey = metrics.benchmark.includes('LOCOMO') ? 'LOCOMO' : 'LongMemEval';
  const targets = COMPARISON_TARGETS[benchKey];
  if (targets) {
    console.log(`\n  COMPARISON`);
    console.log(`  ${'-'.repeat(56)}`);

    const entries = [
      { name: 'Paisley Park', accuracy: metrics.overallAccuracy, source: 'This run' },
      ...Object.entries(targets).map(([name, t]) => ({
        name,
        accuracy: t.accuracy,
        source: t.source,
      })),
    ];

    // Sort by accuracy descending
    entries.sort((a, b) => b.accuracy - a.accuracy);

    const maxNameLen = Math.max(...entries.map((e) => e.name.length));
    for (const entry of entries) {
      const name = entry.name.padEnd(maxNameLen);
      const pct = (entry.accuracy * 100).toFixed(2).padStart(6);
      const marker = entry.source === 'This run' ? ' <--' : '';
      console.log(`    ${name}  ${pct}%  (${entry.source})${marker}`);
    }
  }

  console.log(`\n${line}\n`);
}

function progressBar(ratio: number, width: number): string {
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
