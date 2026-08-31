import { resolve } from 'node:path';

import {
  createRendererComparison,
  parseBenchmarkResult,
  renderRendererComparisonMarkdown,
} from '../packages/client-benchmark/src/index';

function directoryArgument(): string {
  const prefix = '--dir=';
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error('Usage: bun scripts/compare-renderers.ts --dir=<result-directory>');
  return resolve(value);
}

const directory = directoryArgument();
const web = parseBenchmarkResult(await Bun.file(resolve(directory, 'web-virtual.json')).json());
const gpuix = parseBenchmarkResult(await Bun.file(resolve(directory, 'gpuix.json')).json());
const comparison = createRendererComparison(web, gpuix);

await Promise.all([
  Bun.write(resolve(directory, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`),
  Bun.write(resolve(directory, 'comparison.md'), renderRendererComparisonMarkdown(comparison)),
]);

process.stdout.write(`${comparison.verdict.overall}\n`);
