/**
 * Central server build script — bundles into dist/index.js.
 */
import { rm, mkdir } from 'fs/promises';

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

console.log(`✓ Central server built successfully (${BUILD_INFO.label})`);
