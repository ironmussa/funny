import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import type { BenchmarkMetrics, QuestionResult } from '../types.js';

interface FullReport {
  metadata: {
    timestamp: string;
    version: string;
  };
  metrics: BenchmarkMetrics;
  results: QuestionResult[];
}

/**
 * Write full benchmark results to a JSON file.
 * File path: {dataDir}/results/{benchmark}-{timestamp}.json
 */
export async function writeJsonReport(
  dataDir: string,
  metrics: BenchmarkMetrics,
  results: QuestionResult[],
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${metrics.benchmark.toLowerCase().replace(/\s+/g, '-')}-${timestamp}.json`;
  const resultsDir = join(dataDir, 'results');
  const filePath = join(resultsDir, filename);

  await mkdir(resultsDir, { recursive: true });

  const report: FullReport = {
    metadata: {
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    },
    metrics,
    results,
  };

  await writeFile(filePath, JSON.stringify(report, null, 2));
  console.log(`Full results written to: ${filePath}`);

  return filePath;
}
