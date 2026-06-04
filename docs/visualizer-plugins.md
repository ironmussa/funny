# Visualizer Plugins

Visualizer plugins extend how funny renders content — they turn a fenced code
block or a file preview into a rich, interactive view. funny ships **Mermaid**
as a built-in visualizer, built on the exact same contract a third-party plugin
uses, so anything the built-in does, your plugin can too.

A plugin can claim:

- **fenced code languages** — e.g. a ` ```csv ` block renders as a table, and
- **file extensions** — e.g. opening a `.csv` file shows a table preview.

- [Security model](#security-model)
- [Installing & managing plugins](#installing--managing-plugins)
- [Creating a plugin](#creating-a-plugin)
- [How it works under the hood](#how-it-works-under-the-hood)
- [Troubleshooting](#troubleshooting)

---

## Security model

**Full trust, no sandbox.** A visualizer shares the host's React tree and runs
inside your authenticated session — it can read the DOM, your cookies, and call
`/api/*` as you. Installing a plugin is exactly like installing an npm package:
**you are the trust boundary.** Only install extensions you trust.

This is deliberate and consistent with funny's runner model ("runners are not
sandboxed; only connect what you trust"). It also means a plugin can use any
host hook directly (theme, font size) without a permission layer.

Because a plugin is global to the server and its code is loaded into **every**
user's browser, **installing and removing plugins is admin-only.** Any logged-in
user can *see* what is installed.

---

## Installing & managing plugins

Plugins live on the **server host** at `~/.funny/extensions/<name>/`, one
self-contained directory per plugin. There are three ways to install one.

### 1. Settings → Extensions (UI)

Open **Settings → Extensions**. Admins get an install field (a local package
directory path on the server) and a remove button per plugin. Non-admins see the
installed list read-only. Newly installed visualizers register immediately;
removed ones fully unload on the next page reload.

### 2. CLI

```bash
funny ext list                 # List installed extensions
funny ext install <path>       # Install a local pre-built package directory
funny ext remove <name>        # Remove an installed extension
```

`funny ext` runs without starting the server and operates directly on
`~/.funny/extensions`. Example — install the bundled reference plugin:

```bash
funny ext install examples/funny-visualizer-csv
funny ext list
#   funny-visualizer-csv         funny-visualizer-csv@0.1.0
```

> The data directory honors `FUNNY_DATA_DIR` / `FUNNY_CENTRAL_DATA_DIR`, so
> `FUNNY_DATA_DIR=/tmp/x funny ext list` targets a different install.

### 3. Manual copy

```bash
cp -r examples/funny-visualizer-csv ~/.funny/extensions/funny-visualizer-csv
```

Reload the app and the plugin is discovered.

### Where plugins live & how they're served

| | |
|---|---|
| On-disk location | `~/.funny/extensions/<dirName>/` (server host) |
| Discovery / manifest | `GET /api/extensions` |
| Management list | `GET /api/extensions/installed` |
| Install (admin) | `POST /api/extensions/install` → `{ "path": "/abs/dir" }` |
| Remove (admin) | `DELETE /api/extensions/:name` |
| Asset serving | `GET /extensions/<dirName>/<file>` |

Removing a plugin deletes its directory. Discovery is resilient: a malformed or
unsafe package is skipped silently rather than breaking the others.

---

## Creating a plugin

A plugin is an **ESM package** that:

1. lists `react` and `@funny/host` as **`peerDependencies`** (never bundle them),
2. **builds to ESM** importing those as bare specifiers,
3. **default-exports** a `VisualizerPlugin`, and
4. points `package.json` → **`funny.client`** at the built entry.

A complete, working reference lives at
[`examples/funny-visualizer-csv`](../examples/funny-visualizer-csv) — copy it as
a starting point.

### The contract

The public author SDK is the **`@funny/host`** package. Keep your imports to it:

```ts
import {
  useFunnyTheme,
  useFunnyFontSize,
  type VisualizerPlugin,
  type VisualizerProps,
} from '@funny/host';

function CsvTable({ source, fill }: VisualizerProps) {
  const theme = useFunnyTheme();      // 'light' | 'dark'
  const fontPx = useFunnyFontSize();  // number (px)
  // …render `source`…
}

const plugin: VisualizerPlugin = {
  id: 'funny-visualizer-csv',         // stable, unique
  version: '0.1.0',
  contributes: {
    fences: ['csv'],                  // ```csv blocks
    fileExtensions: ['.csv'],         // .csv file previews (leading dot optional)
  },
  Component: CsvTable,
};

export default plugin;
```

`VisualizerProps`:

| prop | type | meaning |
|---|---|---|
| `source` | `string` | the fenced-block contents, or the full file contents |
| `fill` | `boolean?` | `true` when rendered as a full file-preview pane (vs. an inline block) — use it to fill available height |

Props are intentionally minimal: because your component shares the host's React
tree, read theme / font size from the host hooks rather than threading them
through props.

### `package.json`

```json
{
  "name": "funny-visualizer-csv",
  "version": "0.1.0",
  "type": "module",
  "funny": { "client": "dist/index.mjs" },
  "peerDependencies": { "react": ">=19", "@funny/host": ">=1" },
  "devDependencies": { "esbuild": "^0.25.0" }
}
```

- `funny.client` is the entry funny loads — a path **inside the package** that
  resolves to the built ESM bundle. Required.
- The on-disk directory name is derived from `name` (scope/special chars are
  sanitized, e.g. `@acme/foo` → `acme-foo`); it's the handle used to remove the
  plugin.

### Build

Externalize `react` and `@funny/host` so they resolve to the host's instances at
runtime (see below), and emit ESM:

```bash
esbuild src/index.tsx \
  --bundle --format=esm --jsx=automatic \
  --external:react --external:react/jsx-runtime --external:@funny/host \
  --outfile=dist/index.mjs
```

> **Critical: never bundle React.** Your plugin must use the *host's* single
> React instance. Bundling a second copy triggers the classic
> `Invalid hook call` error. `peerDependencies` + `--external:react` is what
> keeps React external; an import map in the host then points the bare `react`
> specifier at the host's instance.

### Respect theme & font size

Per funny's UI rules, render with the active theme and font size. The cleanest
options:

- inherit the host's CSS variables / Tailwind theme automatically (a component
  in the host tree already does), and/or
- read `useFunnyTheme()` / `useFunnyFontSize()` when you need the value in JS
  (e.g. to configure a chart library).

Avoid hardcoded colors and pixel font sizes.

### Conflicts & overriding built-ins

If two plugins claim the same fence or extension, **the last one registered
wins**. Built-ins register first, so an installed plugin can intentionally
override a built-in (e.g. Mermaid). Overrides are logged.

---

## How it works under the hood

```
~/.funny/extensions/<name>/         server host (pre-built ESM packages)
        │  discover (read package.json → funny.client)
        ▼
GET /api/extensions  ──────────────▶  manifest [{ id, version, entryUrl }]
        │
client boot:
  1. installVisualizerHostGlobals()   ← exposes host React + @funny/host on globalThis
  2. registerBuiltinVisualizers()     ← Mermaid
  3. loadInstalledVisualizers()       ← fetch manifest, import each entryUrl, register
        │
  import(entryUrl)  ── resolves bare `react` / `@funny/host` via the page's ──▶ host instances
                       <script type="importmap"> to /vendor/*.mjs shims
```

Key pieces:

- **Registry** ([`packages/client/src/lib/visualizer-registry.ts`](../packages/client/src/lib/visualizer-registry.ts))
  — maps fences/extensions → plugin. Both the markdown renderer and the file
  preview consult it; nothing is hardcoded.
- **Import map** ([`packages/shared/src/visualizer-importmap.mjs`](../packages/shared/src/visualizer-importmap.mjs))
  — a single source of truth injected into `index.html` that maps `react`,
  `react/jsx-runtime`, and `@funny/host` to tiny `/vendor/*.mjs` shims which
  re-export the host's own module instances. This is what makes "shared React"
  work. The server adds a matching CSP `script-src` hash so the inline import
  map is allowed under the strict policy.
- **Loader** ([`packages/client/src/lib/visualizer-loader.ts`](../packages/client/src/lib/visualizer-loader.ts))
  — fetches the manifest and dynamically imports each plugin. A failed fetch or
  a single broken plugin is logged and skipped; it never breaks the app or the
  other plugins.
- **Server** ([`packages/server/src/lib/extensions.ts`](../packages/server/src/lib/extensions.ts))
  — discovery, install (copy), remove, and path-traversal / symlink-escape
  guards on served assets.

---

## Troubleshooting

**`Invalid hook call` / two copies of React.** Your plugin bundled React instead
of treating it as external. Rebuild with `--external:react
--external:react/jsx-runtime` and `react` in `peerDependencies`.

**Plugin doesn't appear after install.** Reload the page (the loader runs at
boot). Check the browser console for a `visualizers` namespace error — an invalid
default export (missing `id` / `Component`) is logged and skipped. Confirm
`GET /api/extensions` lists it; if not, the package is malformed
(`funny.client` missing, or its entry file doesn't exist).

**`@funny/host was used outside the funny host runtime`.** The plugin ran before
the host installed its globals, or outside funny entirely. Inside funny this
should not happen; if you see it in your own tests, set up the host globals or
mock `@funny/host`.

**Module blocked by CSP / wrong MIME.** Extension JS is served as
`text/javascript` from the same origin (`script-src 'self'`). If you serve assets
yourself, match those headers.

**Removed plugin still rendering.** Removal deletes the package, but the registry
keeps the already-registered component until a page reload. Reload to fully
unload it.
