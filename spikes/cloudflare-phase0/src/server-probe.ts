/**
 * Bundling + boot probe for the real server composition on Workers.
 * `app.ts` is imported inside the handler: Workers forbid random values,
 * timers and I/O at global scope, and several server modules still do that on
 * import (the first one is the logger's telemetry identity). Loading lazily
 * shows what fails after that.
 */
/** The Hono bindings the probe passes: the client address the server reads. */
interface ProbeEnv {
  IP: { address: string };
}

let appPromise: Promise<{
  fetch: (r: Request, env?: ProbeEnv) => Response | Promise<Response>;
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
      // `Object()` boxes a thrown primitive and maps null / undefined to `{}`.
      const thrown: object = Object(error);
      const message = 'message' in thrown ? thrown.message : undefined;
      const stack = 'stack' in thrown ? thrown.stack : undefined;
      return new Response(`probe error: ${message}\n${stack ?? ''}`, { status: 500 });
    }
  },
};
