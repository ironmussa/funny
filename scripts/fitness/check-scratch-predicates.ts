#!/usr/bin/env bun
/**
 * Fitness function: scratch-vs-normal divergence goes through the named
 * predicates (CLAUDE.md → "Scratch threads").
 *
 * Every decision about a thread being scratch lives in one predicate module
 * per side: `packages/runtime/src/services/thread-context.ts` and
 * `packages/client/src/lib/thread-variant.ts`. This fails on a read of the
 * `.isScratch` field anywhere else in `packages/runtime/src` and
 * `packages/client/src`, except:
 *
 * - copying the field into another `isScratch` field (`isScratch: t.isScratch`,
 *   `isScratch: !!t.isScratch`, `isScratch: a ?? b?.isScratch`), which carries
 *   the value without deciding anything;
 * - a selector that returns the field as is (`(t) => t?.isScratch)`), for the
 *   same reason;
 * - the files in `REQUEST_INPUTS`, where `isScratch` is a flag of a create or
 *   list request, or the compose form's mode, not a thread row.
 *
 * Calls (`variant.isScratch(t)`) are not field reads. Tests, stories and
 * `__tests__` are exempt. Exits non-zero on violation; `--self-test` checks
 * the fixtures.
 */

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { walkSources } from './walk-sources';

const ROOT = join(import.meta.dir, '..', '..');
const SCANNED = ['packages/runtime/src', 'packages/client/src'];
const OWNERS = new Set([
  'packages/runtime/src/services/thread-context.ts',
  'packages/client/src/lib/thread-variant.ts',
]);
/** Files where `isScratch` is a request flag, not a thread row field. */
const REQUEST_INPUTS = new Set([
  // Zod schema of the create-thread body: validates the requested flag.
  'packages/runtime/src/validation/schemas.ts',
  // createAndStartThread(params): the caller asks for a scratch thread.
  'packages/runtime/src/services/thread-service/create.ts',
  // listThreads(opts): a list filter, not a row.
  'packages/runtime/src/services/runner-service-provider.ts',
  // buildThreadPayload(input): the compose form asks for a scratch thread.
  'packages/client/src/lib/thread-payload.ts',
  // The prompt input's `isScratch` prop: the compose form is in scratch mode.
  'packages/client/src/components/PromptInputUI.tsx',
  'packages/client/src/components/prompt-input/use-prompt-submit.ts',
]);
const EXCLUDED_FILES = /\.(test|spec|stories)\.tsx?$/;
const FIELD_READ = /\??\.isScratch\b(?!\s*\()/g;
const PATH = String.raw`[\w$]+(?:\??\.[\w$]+)*`;
/** `isScratch: <path>` / `isScratch: !!<path>` / `isScratch: <path> ?? <path>` up to the read. */
const COPY_INTO_FIELD = new RegExp(
  String.raw`\bisScratch\s*:\s*(?:${PATH}\s*\?\?\s*)?(?:!!)?${PATH}$`,
);
/** `(t) => t` / `(t) => (t` just before the read, closed right after it. */
const PASS_THROUGH_SELECTOR = /=>\s*\(?\s*[\w$]+$/;
/** What may follow a copied read: the end of the property or of the object. */
const COPY_END = /^\s*(?:[,}\n]|$)/;

function stripComments(source: string): string {
  // Keep line count: blank out the comment text, not the newlines.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (c, lead: string) => lead + ' '.repeat(c.length - lead.length));
}

function isAllowedRead(code: string, index: number, matchLength: number): boolean {
  const lineStart = code.lastIndexOf('\n', index - 1) + 1;
  const before = code.slice(lineStart, index);
  const after = code.slice(index + matchLength);
  if (COPY_INTO_FIELD.test(before)) return COPY_END.test(after);
  if (PASS_THROUGH_SELECTOR.test(before)) return after.trimStart().startsWith(')');
  return false;
}

/** Violations for one source file (repo-relative path). */
export function classify(file: string, source: string): string[] {
  if (OWNERS.has(file) || REQUEST_INPUTS.has(file)) return [];
  const code = stripComments(source);
  const violations: string[] = [];
  for (const match of code.matchAll(FIELD_READ)) {
    const index = match.index ?? 0;
    if (isAllowedRead(code, index, match[0].length)) continue;
    const line = code.slice(0, index).split('\n').length;
    const owner = file.startsWith('packages/client/')
      ? 'packages/client/src/lib/thread-variant.ts'
      : 'packages/runtime/src/services/thread-context.ts';
    violations.push(
      `${file}:${line}: reads \`.isScratch\` directly; use a predicate from ${owner} (add one when no predicate names the axis)`,
    );
  }
  return violations;
}

function runSelfTest(): void {
  const client = 'packages/client/src/hooks/x.ts';
  const runtime = 'packages/runtime/src/routes/x.ts';
  const allowed: Array<[string, string]> = [
    ['packages/client/src/lib/thread-variant.ts', 'if (thread.isScratch) return 1;'],
    ['packages/runtime/src/services/thread-context.ts', 'return !thread.isScratch;'],
    ['packages/runtime/src/validation/schemas.ts', 'if (data.isScratch && data.mode) {}'],
    [client, 'if (isScratch(thread)) return;'],
    [client, 'const s = variant.isScratch(t);'],
    [client, 'const s = variant.isScratch (t);'],
    [client, '// if (thread.isScratch) used to live here'],
    [client, '/* t.isScratch */ const x = 1;'],
    [client, 'return { id: t.id, isScratch: t.isScratch };'],
    [client, 'const x = { isScratch: !!t.isScratch, title: t.title };'],
    [client, 'isScratch: threadIsScratch ?? lightThread?.isScratch,'],
    [client, 'const v = useThreadSelector((t) => t?.isScratch);'],
    [client, "type A = Pick<Thread, 'isScratch'>;"],
    [client, 'const isScratchScope = scope.id === X;'],
    [runtime, 'isScratch: !!thread.isScratch,'],
  ];
  const forbidden: Array<[string, string]> = [
    [client, 'if (entry.isScratch) return `/scratch/${entry.threadId}`;'],
    [client, "const k = t.isScratch ? 'scratch' : 'normal';"],
    [client, 'if (activeThread?.isScratch) {'],
    [client, 'const ok = payload && !payload.isScratch;'],
    [client, 'isScratch: t.isScratch ? true : false,'],
    [client, 'const v = useThreadSelector((t) => !t?.isScratch);'],
    [runtime, 'if (thread && !thread.isScratch) {'],
    [runtime, 'const isScratch = !!parent.isScratch;'],
    [runtime, 'canDoGitOps({ isScratch: !!source.isScratch }) && other.isScratch'],
  ];
  for (const [file, source] of allowed) {
    const v = classify(file, source);
    if (v.length)
      throw new Error(`self-test: expected no violation for ${source}:\n${v.join('\n')}`);
  }
  for (const [file, source] of forbidden) {
    if (classify(file, source).length === 0) {
      throw new Error(`self-test: expected a violation for ${file}: ${source}`);
    }
  }
  const [first] = classify(client, 'const a = 1;\n\nif (t.isScratch) {}');
  if (!first?.startsWith(`${client}:3:`)) throw new Error(`self-test: wrong line in ${first}`);
  console.log('scratch predicates self-test ok');
}

function main(): void {
  if (process.argv.includes('--self-test')) runSelfTest();
  const violations: string[] = [];
  for (const dir of SCANNED) {
    for (const abs of walkSources(join(ROOT, dir), EXCLUDED_FILES)) {
      const file = relative(ROOT, abs).split(sep).join('/');
      violations.push(...classify(file, readFileSync(abs, 'utf8')));
    }
  }
  if (violations.length > 0) {
    console.error(`Scratch checks outside the scratch predicates:\n${violations.join('\n')}`);
    process.exit(1);
  }
  console.log('scratch predicates ok');
}

main();
