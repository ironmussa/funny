import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  createAgent,
  createSession,
  createToolRegistry,
  defineTool,
  defineWorkflow,
  runWorkflow,
  sandbox,
} from '../index.js';

describe('@funny/harness public exports', () => {
  test('exports stable authoring APIs', () => {
    expect(createAgent).toBeTypeOf('function');
    expect(createSession).toBeTypeOf('function');
    expect(defineTool).toBeTypeOf('function');
    expect(createToolRegistry).toBeTypeOf('function');
    expect(defineWorkflow).toBeTypeOf('function');
    expect(runWorkflow).toBeTypeOf('function');
    expect(sandbox.local()).toEqual({ kind: 'local' });
  });

  test('does not depend on server or runtime packages', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    const deps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.optionalDependencies,
    };
    expect(deps['@ironmussa/funny-runtime']).toBeUndefined();

    const srcFiles = walk(join(process.cwd(), 'src')).filter(
      (file) => file.endsWith('.ts') && !file.includes(`${join('src', '__tests__')}`),
    );
    const source = srcFiles.map((file) => readFileSync(file, 'utf-8')).join('\n');
    expect(source).not.toMatch(/from ['"]@ironmussa\/funny-runtime/);
    expect(source).not.toMatch(/import\(['"]@ironmussa\/funny-runtime/);
    expect(source).not.toMatch(/from ['"].*packages\/server/);
  });
});

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}
