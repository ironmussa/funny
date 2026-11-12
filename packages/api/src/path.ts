/**
 * Where the server mounts the router and the client sends procedure calls.
 *
 * Its own entry (`@funny/api/path`) because it is the one runtime value a
 * browser needs from this package: the main entry builds `appRouter`, and
 * `@trpc/server` refuses to initialize outside a server.
 */
export const TRPC_PATH = '/trpc';
