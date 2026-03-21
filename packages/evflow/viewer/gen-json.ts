#!/usr/bin/env bun
import { writeFileSync } from 'fs';

/**
 * Generate a JSON file from the runtime evflow model.
 * Usage: bun run viewer/gen-json.ts [output-path]
 */
import { createRuntimeModel } from '@funny/shared/evflow-model';

const output = process.argv[2] ?? 'viewer/sample-model.json';
const model = createRuntimeModel();
writeFileSync(output, model.toJSON());
process.stdout.write(`Wrote ${output} (${model.getData().elements.size} elements)\n`);
