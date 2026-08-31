import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageDirectory = join(import.meta.dir, '..');
const repositoryRoot = join(packageDirectory, '..', '..');
const artifactPath = join(repositoryRoot, 'artifacts', 'funny-client-gpuix-release-0.1.0.tgz');
const smokeDirectory = mkdtempSync(join(tmpdir(), 'funny-gpuix-release-smoke-'));
const extractedPackage = join(smokeDirectory, 'package');
const livenessMs = Number(process.env.FUNNY_GPUIX_RELEASE_SMOKE_MS ?? 5_000);

async function runChecked(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn({ cmd: command, cwd, stdout: 'inherit', stderr: 'inherit' });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
}

async function smokeRelease(): Promise<void> {
  if (!(await Bun.file(artifactPath).exists())) {
    throw new Error(`Release artifact is missing: ${artifactPath}`);
  }
  await runChecked(['tar', '-xzf', artifactPath, '-C', smokeDirectory], repositoryRoot);
  await runChecked(['bun', 'install', '--no-progress'], extractedPackage);

  const child = Bun.spawn({
    cmd: ['bun', 'dist/main.js'],
    cwd: extractedPackage,
    env: { ...process.env, FUNNY_GPUX_PERSIST_SESSION: 'false' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const earlyExit = child.exited.then((exitCode) => ({ type: 'exit' as const, exitCode }));
  const liveness = Bun.sleep(livenessMs).then(() => ({ type: 'alive' as const }));
  const result = await Promise.race([earlyExit, liveness]);
  if (result.type === 'exit') {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    throw new Error(
      `Release exited before ${livenessMs}ms with ${result.exitCode}\n${stdout}\n${stderr}`,
    );
  }
  child.kill();
  await child.exited;
  process.stdout.write(
    `GPUIX release smoke passed on ${process.platform}/${process.arch} (${livenessMs}ms liveness)\n`,
  );
}

try {
  await smokeRelease();
} finally {
  rmSync(smokeDirectory, { recursive: true, force: true });
}
