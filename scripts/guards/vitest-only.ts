/**
 * Preloaded by `bun test` (via the package's bunfig.toml) in packages whose
 * suite runs on vitest. Bun's native runner does not honour their vitest
 * config (aliases, setup files, environment), and some of their tests leave
 * handles open under it, so `bun test` there can hang forever with no output
 * instead of failing. Stop at once and say which command to use.
 */
const pkg = process.cwd().split(/[\\/]/).slice(-2).join('/');

console.error(
  [
    '',
    `✗ ${pkg} runs its tests with vitest, not \`bun test\`.`,
    '  Use `bun run test` here (add a file or filter to run part of it),',
    '  or `bun run test` at the repo root for every package.',
    '',
  ].join('\n'),
);
process.exit(1);
