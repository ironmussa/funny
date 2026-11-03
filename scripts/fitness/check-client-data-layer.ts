#!/usr/bin/env bun
/**
 * Fitness function: the client data layer owns server-backed entity state
 * (openspec change adopt-tanstack-db-client, design D11).
 *
 * Rules, for production code in packages/client/src (tests and stories excluded):
 *  1. Collection writes — explicit transactions, `collection.insert/update/delete`
 *     and the thread sync-writer methods — only under `src/data/**`, plus the
 *     migration shims listed in WRITER_SHIMS.
 *  2. The former Zustand thread-index fields (`threadsById`, the bucket arrays
 *     and totals) are not reintroduced as values outside `src/data/**`, which
 *     owns that shape (`ThreadIndexSnapshot`). Type annotations are allowed.
 *  3. The removed legacy index helpers (`patchThread`, `replaceProjectThreads`,
 *     …) are not reintroduced: thread rows are written through the data layer.
 *
 * `--self-test` checks the rules against allowed and forbidden fixtures.
 * Exits non-zero on violation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const CLIENT_SRC = join(ROOT, 'packages/client/src');

/** Migration shims (design D8) that write the threads collection from outside `src/data/`. */
const WRITER_SHIMS = new Set(['stores/thread-row-writes.ts']);

/**
 * Files that may assign values to the former thread-index fields. None: the
 * Zustand index is gone (phase 4); rows and lists live only in the data layer.
 */
const PROJECTION_OWNERS = new Set<string>();

const COLLECTION_WRITE =
  /\bcreateTransaction\s*\(|\bcollection\s*\.\s*(?:insert|update|delete|upsert)\s*\(|\.\s*(?:upsertFromServer|upsertFresh|patchSynced|confirmWrite|removeRows|importRows)\s*\(/;

const PROJECTED_FIELDS =
  'threadsById|threadIdsByProject|scratchThreadIds|sharedThreadIds|threadTotalByProject|scratchThreadTotal|sharedThreadTotal';
/** `field: <value>` in an object literal — but not `field: Type` annotations. */
const PROJECTED_WRITE = new RegExp(
  `\\b(?:${PROJECTED_FIELDS})\\s*:(?!\\s*(?:Record<|string\\[\\]|number\\b|Thread\\b|Partial<|readonly\\b))`,
);

const LEGACY_INDEX_HELPER =
  /\b(?:patchThread|replaceProjectThreads|appendProjectThreads|clearProjectBucket|replaceScratchThreads|replaceSharedThreads|prependScratchThread|removeThread)\s*\(/;
/** Files allowed to call the legacy index helpers. None: they were removed in phase 4. */
const LEGACY_HELPER_OWNERS = new Set<string>();

function isExcluded(rel: string): boolean {
  return (
    rel.startsWith('__tests__/') ||
    /\.(?:test|spec|stories)\.tsx?$/.test(rel) ||
    rel.includes('/__tests__/')
  );
}

interface LineRule {
  label: string;
  pattern: RegExp;
  /** Whether the rule applies to a file (path relative to packages/client/src). */
  appliesTo: (rel: string) => boolean;
}

const inDataLayer = (rel: string) => rel.startsWith('data/');

const LINE_RULES: LineRule[] = [
  {
    label: 'collection write outside src/data',
    pattern: COLLECTION_WRITE,
    appliesTo: (rel) => !inDataLayer(rel) && !WRITER_SHIMS.has(rel),
  },
  {
    label: 'legacy thread-index helper called',
    pattern: LEGACY_INDEX_HELPER,
    appliesTo: (rel) => !LEGACY_HELPER_OWNERS.has(rel),
  },
  {
    label: 'projected thread index written directly',
    pattern: PROJECTED_WRITE,
    appliesTo: (rel) => !inDataLayer(rel) && !PROJECTION_OWNERS.has(rel),
  },
];

/** Code of a line without its `//` comment; empty for blank and block-comment lines. */
function codeOf(line: string): string {
  const code = line.replace(/\/\/.*$/, '').trim();
  return code.startsWith('*') ? '' : code;
}

export function findViolations(rel: string, source: string): string[] {
  const rules = LINE_RULES.filter((rule) => rule.appliesTo(rel));
  const found: string[] = [];
  source.split('\n').forEach((line, index) => {
    const code = codeOf(line);
    if (!code) return;
    for (const rule of rules) {
      if (rule.pattern.test(code))
        found.push(`[${rule.label}] ${rel}:${index + 1}  ${line.trim()}`);
    }
  });
  return found;
}

function runSelfTest(): void {
  const cases: Array<{ rel: string; source: string; violates: boolean }> = [
    {
      rel: 'data/threads/actions.ts',
      source: 'const tx = createTransaction({});',
      violates: false,
    },
    { rel: 'stores/thread-store.ts', source: 'const tx = createTransaction({});', violates: true },
    { rel: 'components/X.tsx', source: "data.collection.update('t1', (d) => d);", violates: true },
    { rel: 'stores/x.ts', source: 'getThreadsData().patchSynced(id, fn);', violates: true },
    { rel: 'stores/thread-row-writes.ts', source: 'data.patchSynced(id, fn);', violates: false },
    { rel: 'stores/thread-projection.ts', source: 'data.patchSynced(id, fn);', violates: true },
    { rel: 'components/OrgSwitcher.tsx', source: 'setState({ threadsById: {} });', violates: true },
    { rel: 'hooks/x.ts', source: '  scratchThreadIds: [],', violates: true },
    {
      rel: 'stores/thread-state.ts',
      source: '  threadsById: Record<string, Thread>;',
      violates: false,
    },
    {
      rel: 'lib/thread-selectors.ts',
      source: '  threadIdsByProject: Record<string, string[]>,',
      violates: false,
    },
    { rel: 'stores/thread-projection.ts', source: '    threadsById: {},', violates: true },
    { rel: 'components/X.stories.tsx', source: 'threadsById: {},', violates: false },
    { rel: 'stores/x.ts', source: '// threadsById: {} in a comment', violates: false },
    { rel: 'hooks/x.ts', source: 'threadMutations.patchThread(state, id, fn)', violates: true },
    { rel: 'stores/thread-store.ts', source: 'patchThreadRow(state, id, fn)', violates: false },
  ];
  const wrong = cases.filter(
    // Excluded files (tests, stories) are never scanned, so they must not expect a violation.
    ({ rel, source, violates }) =>
      isExcluded(rel) ? violates : findViolations(rel, source).length > 0 !== violates,
  );
  if (wrong.length > 0) {
    throw new Error(`client-data-layer self-test misclassified: ${JSON.stringify(wrong)}`);
  }
  console.log('client-data-layer self-test ok');
}

if (import.meta.main) {
  if (process.argv.includes('--self-test')) runSelfTest();

  const violations: string[] = [];
  for (const rel of new Bun.Glob('**/*.{ts,tsx}').scanSync(CLIENT_SRC)) {
    const path = rel.replaceAll('\\', '/');
    if (isExcluded(path)) continue;
    violations.push(...findViolations(path, readFileSync(join(CLIENT_SRC, rel), 'utf8')));
  }

  if (violations.length > 0) {
    console.error('Client data-layer violations:\n');
    for (const v of violations) console.error('  ' + v);
    console.error(`\n${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log('client data layer ok — entity writes stay in src/data');
}
