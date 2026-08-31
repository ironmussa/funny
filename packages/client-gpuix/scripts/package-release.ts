import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const packageDirectory = join(import.meta.dir, '..');
const repositoryRoot = join(packageDirectory, '..', '..');
const artifactsDirectory = join(repositoryRoot, 'artifacts');
const stagingDirectory = join(artifactsDirectory, 'client-gpuix-stage');

rmSync(stagingDirectory, { recursive: true, force: true });
mkdirSync(join(stagingDirectory, 'dist'), { recursive: true });
cpSync(join(packageDirectory, 'dist', 'main.js'), join(stagingDirectory, 'dist', 'main.js'));
cpSync(
  join(packageDirectory, 'NATIVE_READINESS.md'),
  join(stagingDirectory, 'NATIVE_READINESS.md'),
);
writeFileSync(
  join(stagingDirectory, 'package.json'),
  `${JSON.stringify(
    {
      name: '@funny/client-gpuix-release',
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: { start: 'bun dist/main.js' },
      dependencies: {
        '@gpuix/native': '0.5.1',
        '@gpuix/react': '0.5.1',
        react: '^19.2.4',
      },
    },
    null,
    2,
  )}\n`,
);

try {
  const child = Bun.spawn(['bun', 'pm', 'pack', '--destination', artifactsDirectory], {
    cwd: stagingDirectory,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
}
