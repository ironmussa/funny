# funny-visualizer-csv

Reference [funny](../../) visualizer plugin. Renders CSV as a table for:

- fenced code blocks tagged `csv`
- `.csv` files in the file preview

It exists to **dogfood the public visualizer plugin contract** end-to-end: it
lives outside the funny core, depends only on the published `react` +
`@funny/host` peer surface, and is loaded at runtime via the extension loader.

## Build

```bash
npm install
npm run build   # esbuild → dist/index.mjs (react + @funny/host externalized)
```

A pre-built `dist/index.mjs` is checked in so you can install without a toolchain.

## Install

```bash
# CLI
funny ext install examples/funny-visualizer-csv

# or copy manually
cp -r examples/funny-visualizer-csv ~/.funny/extensions/funny-visualizer-csv
```

The server discovers it (`GET /api/extensions`), serves the bundle from
`/extensions/funny-visualizer-csv/dist/index.mjs`, and the client loader imports
and registers it on the next page load. Then a ```csv fenced block or a `.csv`
file preview renders as a table.

> Full-trust model: installing a visualizer runs its code inside your
> authenticated session, exactly like installing an npm package. Only install
> extensions you trust. See [`docs/visualizer-plugins.md`](../../docs/visualizer-plugins.md).
