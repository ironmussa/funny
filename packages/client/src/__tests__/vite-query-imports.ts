/**
 * Preloaded by `bun test` (bunfig.toml): resolves Vite's asset query imports
 * (`./x.js?url`, `y?worker`), which bun would otherwise load as plain modules
 * without a default export. A `?url` import becomes its path, a `?worker` one a
 * do-nothing class.
 */
interface PluginBuild {
  onResolve(o: { filter: RegExp }, cb: (args: { path: string }) => unknown): void;
  onLoad(o: { filter: RegExp; namespace: string }, cb: (args: { path: string }) => unknown): void;
}
// The client's tsconfig has no Bun globals; this file only runs under bun test.
interface BunPluginHost {
  plugin(p: { name: string; setup(build: PluginBuild): void }): void;
}
declare const Bun: BunPluginHost;

Bun.plugin({
  name: 'vite-query-imports',
  setup(build) {
    build.onResolve({ filter: /\?(url|worker)$/ }, (args) => ({
      path: args.path,
      namespace: 'vite-query',
    }));
    build.onLoad({ filter: /.*/, namespace: 'vite-query' }, (args) =>
      args.path.endsWith('?worker')
        ? { contents: 'export default class FakeWorker {}', loader: 'js' }
        : { contents: `export default ${JSON.stringify(args.path)};`, loader: 'js' },
    );
  },
});
