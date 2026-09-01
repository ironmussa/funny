/**
 * Central server build script — bundles into dist/index.js.
 */
import { cp, mkdir, rm } from 'fs/promises';

import { getBuildInfo } from '../../scripts/build-info';

// Git-derived build identity, embedded as __BUILD_INFO__ so the bundle reports
// its build number in logs even when .git is absent at runtime.
const BUILD_INFO = getBuildInfo();

await rm('./dist', { recursive: true, force: true });
await mkdir('./dist', { recursive: true });

await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  define: {
    __BUILD_INFO__: JSON.stringify(BUILD_INFO),
  },
  external: [
    'better-auth',
    'drizzle-orm',
    'hono',
    'nanoid',
    'neverthrow',
    'nodemailer',
    'playwright',
  ],
});

// grpc-js loads the canonical proto descriptor at runtime. Keep it beside the
// bundled server so published artifacts do not depend on repository sources.
await cp('../../protocol', './dist/protocol', { recursive: true });

console.log(`✓ Central server built successfully (${BUILD_INFO.label})`);
