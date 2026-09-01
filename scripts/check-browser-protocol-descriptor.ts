import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BROWSER_V1_SCHEMA_FINGERPRINT } from '../packages/shared/src/browser-protocol.ts';

const fixturePath = new URL('../protocol/browser/v1/fixtures/schema.binpb', import.meta.url);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'funny-browser-v1-'));
const generatedPath = join(temporaryDirectory, 'schema.binpb');

try {
  const result = Bun.spawnSync(
    [
      'bunx',
      '--bun',
      '@bufbuild/buf',
      'build',
      '--path',
      'protocol/browser/v1',
      '-o',
      generatedPath,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode);

  const [expected, generated] = await Promise.all([readFile(fixturePath), readFile(generatedPath)]);
  if (!expected.equals(generated)) {
    console.error(
      'browser.v1 descriptor is stale; run `bun run protocol:descriptor:update` and commit it',
    );
    process.exit(1);
  }
  const fingerprint = `browser.v1:sha256:${createHash('sha256').update(expected).digest('hex')}`;
  if (fingerprint !== BROWSER_V1_SCHEMA_FINGERPRINT) {
    console.error(
      `browser.v1 schema fingerprint is stale; expected ${fingerprint}, received ${BROWSER_V1_SCHEMA_FINGERPRINT}`,
    );
    process.exit(1);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
