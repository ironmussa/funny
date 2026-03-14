/**
 * Central server build script — bundles into dist/index.js.
 */
import { rm, mkdir } from 'fs/promises';

await rm('./dist', { recursive: true, force: true });
await mkdir('./dist', { recursive: true });

await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  external: [
    'better-auth',
    'drizzle-orm',
    'hono',
    'nanoid',
    'neverthrow',
    'nodemailer',
    '@funny/podman-chrome-streaming',
    'playwright',
  ],
});

console.log('✓ Central server built successfully');
