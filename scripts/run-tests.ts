import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface TestPackage {
  name: string;
  dir: string;
}

interface TestResult extends TestPackage {
  code: number;
  durationMs: number;
}

const packagesDir = join(import.meta.dir, '..', 'packages');

function discoverTestPackages(): TestPackage[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(packagesDir, entry.name);
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) return undefined;

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string;
        scripts?: Record<string, string>;
      };

      if (!manifest.scripts?.test) return undefined;

      return {
        name: manifest.name ?? entry.name,
        dir,
      };
    })
    .filter((pkg): pkg is TestPackage => Boolean(pkg))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function runPackageTests(pkg: TestPackage): Promise<TestResult> {
  const start = performance.now();
  console.log(`\n=== ${pkg.name} ===`);

  const proc = Bun.spawn(['bun', 'run', 'test'], {
    cwd: pkg.dir,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const code = await proc.exited;

  return {
    ...pkg,
    code,
    durationMs: performance.now() - start,
  };
}

const packages = discoverTestPackages();
const results: TestResult[] = [];

for (const pkg of packages) {
  results.push(await runPackageTests(pkg));
}

const failed = results.filter((result) => result.code !== 0);

console.log('\n=== Test summary ===');
for (const result of results) {
  const status = result.code === 0 ? 'PASS' : `FAIL (${result.code})`;
  const seconds = (result.durationMs / 1000).toFixed(1);
  console.log(`${status.padEnd(10)} ${result.name} ${seconds}s`);
}

if (failed.length > 0) {
  console.error(`\n${failed.length} package test suite(s) failed.`);
  process.exit(1);
}
