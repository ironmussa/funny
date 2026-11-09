/**
 * Bundling + boot probe for the real server composition on Workers.
 * `app.ts` is imported inside the handler: Workers forbid random values,
 * timers and I/O at global scope, and several server modules still do that on
 * import (the first one is the logger's telemetry identity). Loading lazily
 * shows what fails after that.
 */
let appPromise: Promise<{
  fetch: (r: Request, env?: unknown) => Response | Promise<Response>;
}> | null = null;

export default {
  async fetch(request: Request) {
    try {
      appPromise ??= import('../../../packages/server/src/app.ts').then((m) =>
        m.createServerApp({ authInstance: null, corsOrigins: [] }),
      );
      const app = await appPromise;
      return await app.fetch(request, {
        IP: { address: request.headers.get('cf-connecting-ip') ?? '' },
      });
    } catch (error) {
      appPromise = null;
      const e = error as Error;
      return new Response(`probe error: ${e?.message}\n${e?.stack ?? ''}`, { status: 500 });
    }
  },
};
