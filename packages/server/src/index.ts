/**
 * Server entry point (Bun host).
 *
 * The server initializes its own DB, auth, and data routes.
 * Filesystem/git/agent operations are proxied to remote runners connected
 * over gRPC. The HTTP composition lives in `app.ts`; everything Bun- and
 * process-specific lives in `hosts/bun/`.
 */

import 'zod/compile';
import { resolve } from 'path';

import { startBunServer } from './hosts/bun/main.js';

// Resolved here, not in hosts/bun/: this file sits at the same depth in source
// (`src/index.ts`) and in the bundle (`dist/index.js`), so the client bundle is
// two levels up in both.
const { app, server } = await startBunServer({
  clientDistDir: resolve(import.meta.dir, '..', '..', 'client', 'dist'),
});

export { app, server };
