#!/usr/bin/env bun

import { createConfig } from './config.js';
import { computeMetrics } from './eval/metrics.js';
import { runLocomoBenchmark } from './locomo/runner.js';
import { runLongMemEvalBenchmark } from './longmemeval/runner.js';
import { printReport } from './report/console.js';
import { writeJsonReport } from './report/json.js';
import type { BenchmarkConfig } from './types.js';

function printUsage(): void {
  console.log(`
Usage: bun run bench <benchmark> [options]

Benchmarks:
  locomo          Run LOCOMO benchmark (10 conversations, ~300 questions)
  longmemeval     Run LongMemEval benchmark (multi-session, 5 complexity levels)

Options:
  --model <name>         Extraction/answer model (default: claude-haiku)
  --judge-model <name>   Evaluation judge model (default: claude-sonnet)
  --recall-limit <n>     Facts to retrieve per query (default: 15)
  --min-confidence <n>   Minimum confidence threshold (default: 0.3)
  --size <S|M|L>         LongMemEval dataset size (default: S)
  --ingest-only          Extract and store facts, skip evaluation (~1-2h)
  --reuse-cache          Skip ingestion if DB already has facts (use with full eval)
  --help                 Show this help

Environment variables:
  OPENAI_API_BASE_URL    API base URL (default: http://localhost:8317/v1)
  OPENAI_API_KEY         API key (not required for local OpenAI-compatible API)
  BENCH_MODEL            Default extraction model
  BENCH_JUDGE_MODEL      Default judge model

Workflow:
  1. bun run bench locomo --ingest-only       # First: extract facts (~1-2h)
  2. bun run bench locomo --reuse-cache       # Then: evaluate using cached facts (~8-10h)

Examples:
  bun run bench locomo                                    # Full run (ingest + eval)
  bun run bench locomo --ingest-only                      # Extract facts only
  bun run bench locomo --reuse-cache                      # Eval only (reuse cached facts)
  bun run bench locomo --model claude-sonnet              # Use a different model
  bun run bench longmemeval --size S
  OPENAI_API_BASE_URL=https://api.openai.com/v1 \\
    OPENAI_API_KEY=sk-... bun run bench locomo            # Use OpenAI
`);
}

function parseArgs(args: string[]): {
  benchmark: string | null;
  options: Partial<BenchmarkConfig>;
  size: 'S' | 'M' | 'L';
} {
  const options: Partial<BenchmarkConfig> = {};
  let benchmark: string | null = null;
  let size: 'S' | 'M' | 'L' = 'S';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--ingest-only' || arg === '--dry-run') {
      options.ingestOnly = true;
      continue;
    }

    if (arg === '--reuse-cache') {
      options.reuseCache = true;
      continue;
    }

    if (arg === '--model' && args[i + 1]) {
      options.model = args[++i];
      continue;
    }

    if (arg === '--judge-model' && args[i + 1]) {
      options.judgeModel = args[++i];
      continue;
    }

    if (arg === '--recall-limit' && args[i + 1]) {
      options.recallLimit = parseInt(args[++i], 10);
      continue;
    }

    if (arg === '--min-confidence' && args[i + 1]) {
      options.minConfidence = parseFloat(args[++i]);
      continue;
    }

    if (arg === '--size' && args[i + 1]) {
      const s = args[++i].toUpperCase();
      if (s === 'S' || s === 'M' || s === 'L') {
        size = s;
      } else {
        console.error(`Invalid size: ${s}. Must be S, M, or L.`);
        process.exit(1);
      }
      continue;
    }

    if (!arg.startsWith('-') && !benchmark) {
      benchmark = arg.toLowerCase();
      continue;
    }
  }

  return { benchmark, options, size };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { benchmark, options, size } = parseArgs(args);

  if (!benchmark) {
    printUsage();
    process.exit(1);
  }

  const config = createConfig(options);

  // Validate API key (not required for local servers)
  const isLocalServer =
    config.apiBaseUrl.includes('localhost') || config.apiBaseUrl.includes('127.0.0.1');
  if (!config.apiKey && !isLocalServer) {
    console.error(
      'Error: OPENAI_API_KEY environment variable is required (or use a local API server)',
    );
    process.exit(1);
  }

  console.log(`Paisley Park Benchmark Suite`);
  console.log(
    `Model: ${config.model} | Judge: ${config.judgeModel} | Recall limit: ${config.recallLimit}`,
  );
  if (config.ingestOnly) console.log(`Mode: INGEST ONLY (extract facts, skip evaluation)`);
  if (config.reuseCache) console.log(`Mode: REUSE CACHE (skip ingestion, evaluate only)`);
  console.log('');

  switch (benchmark) {
    case 'locomo': {
      const result = await runLocomoBenchmark(config);

      if (!config.ingestOnly && result.results.length > 0) {
        const metrics = computeMetrics('LOCOMO', result.results, {
          model: config.model,
          recallLimit: config.recallLimit,
          totalFactsCreated: result.totalFactsCreated,
          totalFactsAfterDedup: result.totalFactsAfterDedup,
          dbSizeBytes: result.dbSizeBytes,
          durationSeconds: result.durationSeconds,
        });

        printReport(metrics);
        await writeJsonReport(config.dataDir, metrics, result.results);
      } else {
        console.log(`\nIngestion complete.`);
        console.log(`  Facts created: ${result.totalFactsCreated}`);
        console.log(`  Facts after dedup: ${result.totalFactsAfterDedup}`);
        console.log(`  Extraction tokens: ${result.totalExtractionTokens}`);
        console.log(`  Duration: ${result.durationSeconds.toFixed(1)}s`);
      }
      break;
    }

    case 'longmemeval': {
      const result = await runLongMemEvalBenchmark(config, size);

      if (!config.ingestOnly && result.results.length > 0) {
        const metrics = computeMetrics(`LongMemEval-${size}`, result.results, {
          model: config.model,
          recallLimit: config.recallLimit,
          totalFactsCreated: result.totalFactsCreated,
          totalFactsAfterDedup: result.totalFactsAfterDedup,
          dbSizeBytes: result.dbSizeBytes,
          durationSeconds: result.durationSeconds,
        });

        printReport(metrics);
        await writeJsonReport(config.dataDir, metrics, result.results);
      } else {
        console.log(`\nIngestion complete.`);
        console.log(`  Facts created: ${result.totalFactsCreated}`);
        console.log(`  Facts after dedup: ${result.totalFactsAfterDedup}`);
        console.log(`  Extraction tokens: ${result.totalExtractionTokens}`);
        console.log(`  Duration: ${result.durationSeconds.toFixed(1)}s`);
      }
      break;
    }

    default:
      console.error(`Unknown benchmark: ${benchmark}`);
      console.error('Available: locomo, longmemeval');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
