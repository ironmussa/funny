import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const packageDirectory = join(import.meta.dir, '..');
const repositoryRoot = join(packageDirectory, '..', '..');
const artifactsDirectory = join(repositoryRoot, 'artifacts');
const stagingDirectory = join(artifactsDirectory, 'client-gpuix-stage');

// The bundle leaves these external (see the `build` script), so the release
// installs them. Take their versions from this package's manifest so the
// release cannot drift from what the app is built and tested against.
const RELEASE_EXTERNALS = ['@gpuix/native', '@gpuix/react', 'react'] as const;
const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};
const releaseDependencies = Object.fromEntries(
  RELEASE_EXTERNALS.map((name) => {
    const version = manifest.dependencies[name];
    if (!version) throw new Error(`client-gpuix package.json does not depend on ${name}`);
    return [name, version];
  }),
);

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
      dependencies: releaseDependencies,
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
