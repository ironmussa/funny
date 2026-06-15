# Visualizer Plugins

Visualizer plugins extend how funny renders content — they turn a fenced code
block or a file preview into a rich, interactive view. funny ships **Mermaid**
(diagrams), **CSV** (tables), and **video** (`.mp4`/`.webm`/`.mov`/`.mkv`, the
reference [binary visualizer](#binary-visualizers)) as built-ins, built on the
exact same contract a third-party plugin uses, so anything a built-in does, your
plugin can too. Heavier / more niche renderers (e.g. DBML) ship as installable
extensions.

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
user can _see_ what is installed.

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
funny ext install <git-url>    # Install from a git repo (see below)
funny ext remove <name>        # Remove an installed extension
```

`funny ext` runs without starting the server and operates directly on
`~/.funny/extensions`. Example — install a reference plugin from the
[`funny-extensions`](https://github.com/ironmussa/funny-extensions) repo:

```bash
funny ext install github:ironmussa/funny-extensions --subdir visualizer-dbml
funny ext list
#   visualizer-dbml         funny-visualizer-dbml@0.1.0   (name · runtime id)
```

> The data directory honors `FUNNY_DATA_DIR` / `FUNNY_CENTRAL_DATA_DIR`, so
> `FUNNY_DATA_DIR=/tmp/x funny ext list` targets a different install.

#### Install from a git repo

Point `funny ext install` at a git repository instead of a local directory:

```bash
funny ext install github:you/my-funny-viz                 # default branch
funny ext install github:you/my-funny-viz#v1.0.0          # a tag or branch
funny ext install https://github.com/you/my-funny-viz.git
funny ext install git@github.com:you/my-funny-viz.git     # ssh
funny ext install github:you/monorepo --subdir packages/viz   # subdir of a repo
```

Accepted URL forms are `github:`/`gh:` shorthand, `https://…`, and scp-style
`git@host:…` / `ssh://…`. A trailing `#ref` or `--ref <branch|tag>` selects a
ref (shallow clone, so branches and tags work — not arbitrary commit SHAs).

> **funny clones, it does not build.** Like a VSCode `.vsix` or an Obsidian
> release artifact, the installer fetches your repo's **pre-built** `dist/` and
> copies it — it never runs your build scripts on the server host. The repo must
> commit (or release) a built bundle that `package.json` → `funny.client` points
> at. This keeps install safe (no build-time code execution) and fast. See
> [Publishing your own extension](#publishing-your-own-extension).

The same applies to the API: `POST /api/extensions/install` accepts
`{ "git": "github:you/repo", "ref"?: "...", "subdir"?: "..." }` (admin-only).

### 3. Manual copy

```bash
git clone https://github.com/ironmussa/funny-extensions
cp -r funny-extensions/visualizer-dbml ~/.funny/extensions/visualizer-dbml
```

Reload the app and the plugin is discovered.

### Where plugins live & how they're served

|                      |                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| On-disk location     | `~/.funny/extensions/<dirName>/` (server host)                                                                 |
| Discovery / manifest | `GET /api/extensions`                                                                                          |
| Management list      | `GET /api/extensions/installed`                                                                                |
| Install (admin)      | `POST /api/extensions/install` → `{ "path": "/abs/dir" }` or `{ "git": "github:you/repo", "ref"?, "subdir"? }` |
| Remove (admin)       | `DELETE /api/extensions/:name`                                                                                 |
| Asset serving        | `GET /extensions/<dirName>/<file>`                                                                             |

Removing a plugin deletes its directory. Discovery is resilient: a malformed or
unsafe package is skipped silently rather than breaking the others.

---

## Creating a plugin

A plugin is an **ESM package** that:

1. lists `react` and `@funny/host` as **`peerDependencies`** (never bundle them),
2. **builds to ESM** importing those as bare specifiers,
3. **default-exports** a `VisualizerPlugin`, and
4. points `package.json` → **`funny.client`** at the built entry.

Start from the bare-bones [`visualizer-template`](https://github.com/ironmussa/funny-extensions/tree/master/visualizer-template)
(zero-dep, copy-and-go), or one of the working heavyweight examples that show how
to bundle real deps — all in the [`funny-extensions`](https://github.com/ironmussa/funny-extensions) repo:

| Example                                                                                              | Renders                        | Bundles                            | Notes                                                           |
| ---------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------- | --------------------------------------------------------------- |
| [`visualizer-dbml`](https://github.com/ironmussa/funny-extensions/tree/master/visualizer-dbml)       | ` ```dbml `, `.dbml`           | `@dbml/parse` + React Flow + dagre | Interactive ER diagram; injects a vendored stylesheet.          |
| [`visualizer-dot`](https://github.com/ironmussa/funny-extensions/tree/master/visualizer-dot)         | ` ```dot `, `.dot`, `.gv`      | `@hpcc-js/wasm-graphviz`           | GraphViz → SVG; wasm embedded as base64 (self-contained).       |
| [`visualizer-vega`](https://github.com/ironmussa/funny-extensions/tree/master/visualizer-vega)       | ` ```vega-lite `, ` ```vega `  | `vega-embed`                       | Declarative charts; imperative widget (no host-React conflict). |
| [`visualizer-jupyter`](https://github.com/ironmussa/funny-extensions/tree/master/visualizer-jupyter) | `.ipynb`                       | `marked`                           | Custom nbformat-v4 renderer (cells + outputs).                  |
| [`visualizer-openapi`](https://github.com/ironmussa/funny-extensions/tree/master/visualizer-openapi) | ` ```openapi `, ` ```swagger ` | `swagger-ui-dist` + `js-yaml`      | Swagger UI; bundles its own isolated React.                     |

Each demonstrates a different bundling trick — embedded wasm, an imperative
non-React widget, a hand-rolled renderer, and an isolated second React app. The
CSV snippet below is an illustrative minimal walkthrough (CSV itself ships
built-in).

> **Binary file formats (e.g. Parquet, images).** A visualizer's `source` is a
> UTF-8 **string**, which corrupts binary data. To render bytes, declare
> `contributes.binary: true` and read from `VisualizerProps.src` — a URL to the
> file's raw bytes (`/api/files/raw?path=…`) — instead of `source`. The host
> then skips the text fetch entirely. See [Binary visualizers](#binary-visualizers).

### The contract

The public author SDK is the **`@funny/host`** package. Keep your imports to it:

````ts
import {
  useFunnyTheme,
  useFunnyFontSize,
  type VisualizerPlugin,
  type VisualizerProps,
} from '@funny/host';

function CsvTable({ source, fill }: VisualizerProps) {
  const theme = useFunnyTheme(); // 'light' | 'dark'
  const fontPx = useFunnyFontSize(); // number (px)
  // …render `source`…
}

const plugin: VisualizerPlugin = {
  id: 'funny-visualizer-csv', // stable, unique
  version: '0.1.0',
  contributes: {
    fences: ['csv'], // ```csv blocks
    fileExtensions: ['.csv'], // .csv file previews (leading dot optional)
  },
  Component: CsvTable,
};

export default plugin;
````

`VisualizerProps`:

| prop     | type       | meaning                                                                                                  |
| -------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `source` | `string`   | the fenced-block contents, or the full file contents (empty for a `binary` visualizer)                   |
| `fill`   | `boolean?` | `true` when rendered as a full file-preview pane (vs. an inline block) — use it to fill available height |
| `src`    | `string?`  | URL to the file's raw bytes (`/api/files/raw?path=…`), present only in file-preview mode — see below     |

Props are intentionally minimal: because your component shares the host's React
tree, read theme / font size from the host hooks rather than threading them
through props.

### Binary visualizers

`source` is a UTF-8 string, so it corrupts binary formats (images, Parquet,
Arrow, …). To render bytes, set `contributes.binary: true` and read from `src`
instead — a URL to the file's raw bytes the host serves from
`/api/files/raw?path=…`. The host detects a binary visualizer and **skips the
text fetch**, so `source` arrives empty and only `src` is populated.

```ts
const plugin: VisualizerPlugin = {
  id: 'funny-visualizer-image',
  version: '0.1.0',
  contributes: {
    fileExtensions: ['.png', '.jpg', '.webp', '.gif'],
    binary: true, // ← read `src`, not `source`
  },
  Component: ({ src }: VisualizerProps) =>
    src ? <img src={src} style={{ maxWidth: '100%' }} /> : null,
};
```

`binary` only applies to `fileExtensions` — fenced code blocks are always text,
so a `binary` visualizer's `fences` (if any) still receive `source`.

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

> **Critical: never bundle React.** Your plugin must use the _host's_ single
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

## Publishing your own extension

To distribute an extension, put it in its **own git repo** and install it with
`funny ext install <git-url>`. The fastest start is the ready-to-copy template:

```bash
git clone https://github.com/ironmussa/funny-extensions
cp -r funny-extensions/visualizer-template ../my-funny-viz
cd ../my-funny-viz && rm -rf .git && git init
npm install
npm run build            # → dist/index.mjs
funny ext install .      # try it locally first
git add -A && git commit -m "initial visualizer"
git push                 # to your GitHub repo
```

Then anyone (an admin) installs it with `funny ext install github:you/my-funny-viz`.

The template ([`visualizer-template`](https://github.com/ironmussa/funny-extensions/tree/master/visualizer-template))
includes the build script, a `@funny/host` type shim so `tsc` works offline
(the SDK isn't on npm — it's provided at runtime), and a CI workflow that fails
if the committed `dist/` is stale.

**Commit your `dist/`.** funny installs the **pre-built** bundle straight from
the repo and never runs your build — the same model as a VSCode `.vsix` or an
Obsidian release artifact. Always `npm run build` and commit `dist/` before
tagging a release; tag releases (`#v1.0.0`) so installs can pin a version.

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
  `react/jsx-runtime`, `react-dom`, and `@funny/host` to tiny `/vendor/*.mjs`
  shims which re-export the host's own module instances. This is what makes
  "shared React"
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
