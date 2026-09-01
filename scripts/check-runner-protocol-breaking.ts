const requestedRef = process.env.RUNNER_PROTOCOL_AGAINST;
const candidateRefs = requestedRef
  ? [requestedRef]
  : ['origin/develop', 'develop', 'origin/main', 'main'];

function gitSucceeds(args: string[]): boolean {
  return Bun.spawnSync(['git', ...args], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
}

const baselineRef = candidateRefs.find(
  (candidate) =>
    gitSucceeds(['rev-parse', '--verify', candidate]) &&
    gitSucceeds(['cat-file', '-e', `${candidate}:protocol/runner/v2`]),
);

if (!baselineRef) {
  console.log(
    'runner protocol: no v2 schema exists on a base branch; breaking check is not applicable',
  );
  process.exit(0);
}

const resolved = Bun.spawnSync(['git', 'rev-parse', baselineRef], {
  stdout: 'pipe',
  stderr: 'inherit',
});
if (resolved.exitCode !== 0) process.exit(resolved.exitCode);

const commit = new TextDecoder().decode(resolved.stdout).trim();
const result = Bun.spawnSync(
  [
    'bunx',
    '--bun',
    '@bufbuild/buf',
    'breaking',
    'protocol',
    '--against',
    `.git#ref=${commit},subdir=protocol`,
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
process.exit(result.exitCode);
