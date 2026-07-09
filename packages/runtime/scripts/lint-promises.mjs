import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const load = Module['_load'];
const typescriptForTypescriptEslint = require.resolve('typescript-eslint-typescript');

function resolveTypescriptForTypescriptEslint(request) {
  if (request === 'typescript') return typescriptForTypescriptEslint;
  return require.resolve(request.replace(/^typescript\//, 'typescript-eslint-typescript/'));
}

Module['_load'] = function loadWithTypescriptEslintFallback(request, parent, isMain) {
  const isTypescriptEslint =
    parent?.filename.includes('@typescript-eslint') ||
    parent?.filename.includes('typescript-eslint') ||
    parent?.filename.includes('ts-api-utils');

  if ((request === 'typescript' || request.startsWith('typescript/')) && isTypescriptEslint) {
    return load.call(this, resolveTypescriptForTypescriptEslint(request), parent, isMain);
  }

  return load.call(this, request, parent, isMain);
};

const { ESLint } = await import('eslint');
const eslint = new ESLint();
const results = await eslint.lintFiles(process.argv.slice(2));
const formatter = await eslint.loadFormatter('stylish');
const output = formatter.format(results);

if (output) console.log(output);

const errorCount = results.reduce((total, result) => total + result.errorCount, 0);
process.exitCode = errorCount > 0 ? 1 : 0;
