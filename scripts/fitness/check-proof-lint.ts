/** Lint a temporary mirror with production paths and the real configuration. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const consumer = 'packages/server/src/routes/proof-lint-fixture.ts';
const trusted = 'packages/server/src/modules/threads/domain/proofs/thread-owned-by.ts';
const runnerProver = 'packages/server/src/services/runner-access/runner-for.ts';
const fixtures = [
  {
    name: 'valid checker',
    path: trusted,
    rule: null,
    code: `import { defineProof } from '@gdp-ts/core'; const p = defineProof('Owned'); export function check(a) { return p.prove(a); }`,
  },
  {
    name: 'direct cast',
    path: consumer,
    rule: 'no-proof-assertion',
    code: `import type { ThreadOwnedBy } from '../modules/threads/domain/proofs/thread-owned-by.js'; export const forged = {} as ThreadOwnedBy<unknown, unknown>;`,
  },
  {
    name: 'barrel cast',
    path: consumer,
    rule: 'no-proof-assertion',
    code: `import type { ThreadOwnedBy } from '../modules/threads/index.js'; export const forged = {} as ThreadOwnedBy<unknown, unknown>;`,
  },
  {
    name: 'unauthorized mint',
    path: consumer,
    rule: 'no-define-proof',
    code: `import { defineProof } from '@gdp-ts/core'; export const forged = defineProof('Owned');`,
  },
  {
    name: 'exported prover',
    path: trusted,
    rule: 'no-exported-prover',
    code: `import { defineProof } from '@gdp-ts/core'; export const forged = defineProof('Owned');`,
  },
  {
    name: 'prover re-exported by specifier',
    path: trusted,
    rule: 'no-exported-prover',
    code: `import { defineProof } from '@gdp-ts/core'; const forged = defineProof('Owned'); export { forged };`,
  },
  {
    name: 'prover default export',
    path: trusted,
    rule: 'no-exported-prover',
    code: `import { defineProof } from '@gdp-ts/core'; export default defineProof('Owned');`,
  },
  {
    name: 'double cast through unknown',
    path: consumer,
    rule: 'no-proof-assertion',
    code: `import type { ThreadOwnedBy } from '../modules/threads/index.js'; export const forged = {} as unknown as ThreadOwnedBy<unknown, unknown>;`,
  },
  {
    name: 'angle-bracket cast',
    path: consumer,
    rule: 'no-proof-assertion',
    code: `import type { ThreadOwnedBy } from '../modules/threads/index.js'; export const forged = <ThreadOwnedBy<unknown, unknown>>{};`,
  },
  {
    name: 'mint in another module file',
    path: 'packages/server/src/modules/threads/application/fork-thread.ts',
    rule: 'no-define-proof',
    code: `import { defineProof } from '@gdp-ts/core'; export function f() { return defineProof('Owned'); }`,
  },
  {
    name: 'strict any',
    path: 'packages/server/src/modules/threads/application/fork-thread.ts',
    rule: 'no-any',
    code: `export const forged: any = null;`,
  },
  // ── runner-request-isolation ────────────────────────────────
  {
    name: 'runner prover: valid checker',
    path: runnerProver,
    rule: null,
    code: `import { defineProof } from '@gdp-ts/core'; const p = defineProof('RunnerFor'); export function check(a, r) { return p.prove(a, r); }`,
  },
  {
    name: 'runner prover: exported prover',
    path: runnerProver,
    rule: 'no-exported-prover',
    code: `import { defineProof } from '@gdp-ts/core'; export const RunnerFor = defineProof('RunnerFor');`,
  },
  {
    name: 'forged RunnerFor cast (direct file)',
    path: consumer,
    rule: 'no-proof-assertion',
    code: `import type { RunnerFor } from '../services/runner-access/runner-for.js'; export const forged = {} as RunnerFor<unknown, unknown>;`,
  },
  {
    name: 'forged RunnerFor cast (barrel)',
    path: consumer,
    rule: 'no-proof-assertion',
    code: `import type { RunnerFor } from '../services/runner-access/index.js'; export const forged = {} as unknown as RunnerFor<unknown, unknown>;`,
  },
  {
    name: 'forged OAuthCallbackRunner cast',
    path: 'packages/server/src/middleware/proxy.ts',
    rule: 'no-proof-assertion',
    code: `import type { OAuthCallbackRunner } from '../services/runner-access/index.js'; export const forged = <OAuthCallbackRunner<unknown>>{};`,
  },
  {
    name: 'minting RunnerFor in the sink file',
    path: 'packages/server/src/services/runner-access/authorized-runner-requests.ts',
    rule: 'no-define-proof',
    code: `import { defineProof } from '@gdp-ts/core'; export const forged = defineProof('RunnerFor');`,
  },
  {
    name: 'minting RunnerFor in a route',
    path: consumer,
    rule: 'no-define-proof',
    code: `import { defineProof } from '@gdp-ts/core'; export function f() { return defineProof('RunnerFor'); }`,
  },
  {
    name: 'strict any in the sink file',
    path: 'packages/server/src/services/runner-access/authorized-runner-requests.ts',
    rule: 'no-any',
    code: `export const forged: any = null;`,
  },
];
const root = resolve(import.meta.dir, '../..');
const sandbox = mkdtempSync(join(tmpdir(), 'funny-proof-lint-'));
try {
  copyFileSync(join(root, 'oxlint.config.ts'), join(sandbox, 'oxlint.config.ts'));
  symlinkSync(join(root, 'node_modules'), join(sandbox, 'node_modules'));
  for (const fixture of fixtures) {
    const file = join(sandbox, fixture.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fixture.code);
    const result = spawnSync(
      join(root, 'node_modules/.bin/oxlint'),
      ['--format', 'json', fixture.path],
      { cwd: sandbox, encoding: 'utf8' },
    );
    const report = JSON.parse(result.stdout);
    const errors = report.diagnostics.filter((d: { severity: string }) => d.severity === 'error');
    const expected = fixture.rule;
    if (
      expected
        ? result.status !== 1 || !errors.some((d: { code: string }) => d.code.includes(expected))
        : result.status !== 0 || errors.length
    ) {
      throw new Error(
        `${fixture.name}: unexpected lint result\n${result.stdout}\n${result.stderr}`,
      );
    }
    console.log(`✓ ${fixture.name}`);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
