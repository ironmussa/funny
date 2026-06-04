# funny-visualizer-dbml

DBML → **interactive ER diagram** visualizer for [funny](../../), rendered with
React Flow (tables, columns, PK/FK badges, relationship edges, zoom + expand).
Renders:

- fenced code blocks tagged `dbml`
- `.dbml` files in the file preview

It is **fully decoupled from funny's core**: it bundles its own
`@dbml/parse` + `@xyflow/react` + `@dagrejs/dagre` and depends only on the
public `react` + `@funny/host` peer surface. None of those heavy deps land in
funny's base bundle — they ship inside this extension.

## Build

```bash
npm install
npm run build   # esbuild → dist/index.mjs (deps bundled; react + @funny/host external)
```

The build inlines React Flow's stylesheet as text and the plugin injects it once
at runtime (a dynamically-imported ESM module can't side-load a CSS file). A
pre-built `dist/index.mjs` is checked in so you can install without a toolchain.

## Install

```bash
# CLI
funny ext install examples/funny-visualizer-dbml

# or copy manually
cp -r examples/funny-visualizer-dbml ~/.funny/extensions/funny-visualizer-dbml
```

Reload funny, then a ```dbml fenced block or a `.dbml` file preview renders as
an ER diagram.

## Sample

````md
```dbml
Table users {
  id int [pk]
  email varchar
  org_id int [ref: > orgs.id]
}

Table orgs {
  id int [pk]
  name varchar
}
```
````

> Full-trust model: installing a visualizer runs its code inside your
> authenticated session, like installing an npm package. Only install extensions
> you trust. See [`docs/visualizer-plugins.md`](../../docs/visualizer-plugins.md).
