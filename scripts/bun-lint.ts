// Runs Bun's built-in linter (`bun lint`) with the repository's flags. It reads
// oxlint.config.ts, including its JS plugins (anti-slop, gdp-ts, shadcn, zod).
//
// Scripts and hooks call this file instead of `bun lint` directly: a Bun
// without the lint command treats `bun lint` as `bun run lint`, and the root
// `lint` script would then call itself forever.
//
//   bun scripts/bun-lint.ts .            every file
//   bun scripts/bun-lint.ts --fix .      apply safe fixes
//   bun scripts/bun-lint.ts a.ts b.tsx   only these files (the pre-commit hook)

/** First Bun with `bun lint` (1.4.6 canary). */
const MIN_BUN = '1.4.6';

if (Bun.semver.order(Bun.version, MIN_BUN) < 0) {
  console.error(
    `bun lint needs Bun ${MIN_BUN} or newer (canary), this is ${Bun.version}.\n` +
      'Install it with: bun upgrade --canary',
  );
  process.exit(1);
}

const args = Bun.argv.slice(2);
// Piped (the steps runner, hooks, CI), `bun lint` still prints its pretty code
// frames. The agent format is one `file:line:col: warning rule: message` line
// per problem, which the task-progress parser reads. A terminal keeps pretty.
const formatChosen = args.some((arg) => arg === '-f' || arg.startsWith('--format'));
const format = !formatChosen && !process.stdout.isTTY ? ['--format', 'agent'] : [];

const run = Bun.spawnSync(
  // --no-script: run the linter, not the package's `lint` script.
  // --disable-nested-config: one config (the root oxlint.config.ts) for every
  // file, so packages/runtime/eslint.config.mjs (lint:promises) is not picked up.
  [process.execPath, 'lint', '--no-script', '--disable-nested-config', ...format, ...args],
  { stdio: ['inherit', 'inherit', 'inherit'] },
);
process.exit(run.exitCode ?? 1);
