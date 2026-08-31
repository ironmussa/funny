# Experimental GPUIX client

Funny includes an experimental native GPUIX product client for the primary authenticated thread
workflow. React DOM remains the default renderer and the immediate fallback.

## Launch

Start the normal web client:

```bash
bun run dev:client:renderer
```

Select GPUIX explicitly:

```bash
bun run dev:client:gpuix
```

Build the native release entry:

```bash
bun run build:client:gpuix
bun run --cwd packages/client-gpuix start:release
```

The native client uses `FUNNY_SERVER_ORIGIN` for the Funny server (the local composition default is
`http://localhost:5002`) and `FUNNY_CLIENT_ORIGIN` for the origin allowed by the server's Socket.IO
and CSRF configuration (default `http://localhost:5173`). Configure that origin in `CORS_ORIGIN` on
the server. Set `FUNNY_GPUX_PERSIST_SESSION=false` to keep the session cookie only in memory.

## Native window controls

The GPUIX window keeps the host title bar enabled, is resizable, and requests the standard close,
maximize, and minimize controls from the operating system. macOS and Windows use their native
window chrome automatically; the Linux backend preference below is ignored on those platforms.

On Linux, some Wayland compositors do not decorate GPUIX 0.5.1 windows. Keep the published binary on
the inherited backend:

```dotenv
FUNNY_GPUIX_LINUX_BACKEND=auto
```

Accepted values are `auto`, `x11`, and `wayland`. `auto` and `wayland` preserve the inherited display
environment. Runtime tracing on GPUIX 0.5.1's published Linux binary found that forcing `x11` opens no
X11 connection and leaves the renderer headless, so `x11` is reserved for a rebuilt native binding.
Usable Wayland controls require that binding to expose GPUI window-control areas for drag, minimize,
maximize/restore, and close; the pinned public JavaScript API does not expose those operations.

## Diagnostics and performance overlay

The native frame overlay and product diagnostic surface are hidden during a normal launch. Enable
both explicitly with:

```bash
FUNNY_GPUIX_DIAGNOSTICS=true bun run dev:client:gpuix
```

The overlay is painted directly by GPUIX after layout, so collecting and displaying its stats does
not add a React render for each frame. `CUR` is the latest native draw time; the percentile and
maximum values expose spikes, while `FRAMES` is the accumulated native frame count for the current
process. Convert draw time to approximate capacity with `1000 / milliseconds`: 16.7 ms is about 60
FPS, 33.3 ms about 30 FPS, and 8.3 ms about 120 FPS. Controlled benchmark entry points enable this
collection independently, even when the product default remains hidden.

These values diagnose layout and draw cost. They are not a presentation acknowledgement from the
display, so input-to-present latency remains unsupported.

Diagnostic mode adds two controls to the thread header. `Rendering: Rich`/`Rendering: Fast` names
the mode currently in use rather than the action a click will perform. `Reset stats` clears the
overlay's accumulated current/percentile/maximum sample window so a scenario can be measured from a
clean boundary; collection continues immediately after the reset. Neither control is present in a
normal launch.

## Supported hosts and fallback

Pinned GPUIX 0.5.1 publishes native binaries for macOS arm64/x64, glibc Linux arm64/x64, and Windows
arm64/x64. Linux musl and other targets are rejected before renderer initialization with the exact
fallback command:

```bash
bun run dev:client
```

Removing the explicit `--renderer=gpuix` selection or using the normal development command restores
the unchanged web default. Native failures do not migrate or delete browser preferences, sessions,
projects, threads, or server messages.

## MVP scope

The client supports session restoration, login/logout, accessible project navigation, scratch and
shared threads, paginated variable-height history, Markdown/code/table/tool/diff rows, streaming,
prompt submission, stop/resume, and structured permission responses. It intentionally does not
include terminal emulation, embedded browser content, Dockview, Monaco, workflows, plugins, the test
runner, Dockview's tab groups/floating panels, or the complete settings surface. The primary native
shell does provide its own lightweight dock layout: navigation and conversation can be reordered
from their handles and resized from the separator.

Session persistence stores only the reusable cookie header in the per-user application-data
directory with mode `0600` where supported. Submitted passwords are never written. Malformed or
unavailable persistence falls back safely and emits redacted diagnostics.

During assistant streaming, only the changing transcript branch subscribes to message data. The
thread header, prompt composer, and permission card subscribe to their own run/access/permission
values and remain stable across content-only fragments. A message with streaming delivery uses the
bounded plain-text preview even when Rich mode is selected; when its durable form arrives, the same
row returns to the selected Rich or Fast presentation. This avoids repeated Markdown and diff
layout while tokens are arriving without changing persisted content.

## Known limitations

- GPUIX 0.5.1 does not expose secure-text input. The experimental login visibly warns about this;
  do not enter sensitive credentials outside a trusted local environment.
- GPUIX does not expose accessibility-label or screen-reader semantics in its public intrinsic props.
  Controls have deterministic focus order, keyboard activation, visible labels, and automation IDs,
  but accessibility promotion remains blocked on a renderer API.
- Presented-frame and input-to-present timings remain inconclusive because the pinned public API has
  no verified presentation acknowledgement.
- GPUIX 0.5.1 exposes child-control focus but no verified independent window-focus callback. The
  native platform therefore remains conservatively focused and visible for the window lifetime and
  transitions inactive only at stop or termination; child focus changes never drive lifecycle.
- Native renderer tests are skipped explicitly on hosts where GPUIX lacks its test renderer. CI
  requires that renderer on macOS and Windows, so an unexpected absence fails the platform job.

## Release-smoke handoff

The extracted release tarball passed build, dependency-install, and native process/window-liveness
smoke on glibc Linux x64. The published GPUIX matrix also includes glibc Linux arm64, macOS arm64/x64,
and Windows arm64/x64, but those targets were not executed on this machine and remain release
candidates. Linux musl is explicitly unsupported.

## Troubleshooting

- `Origin not allowed`: align `FUNNY_CLIENT_ORIGIN` with a value in server `CORS_ORIGIN`.
- `No authenticated session`: sign in again or remove the native `session.json` file.
- Storage diagnostic: verify ownership and permissions of the Funny application-data directory; the
  client continues with in-memory preferences where possible.
- Renderer startup or crash: run `bun run dev:client` and retain the redacted diagnostic JSON written
  to stderr.

Benchmark artifacts are written beneath `benchmark-results/<timestamp>/` and are intentionally
gitignored. See [renderer-benchmark.md](renderer-benchmark.md) for controlled comparison rules.

## Visual parity

The React and GPUIX thread surfaces consume `@funny/ui-contracts` for the named
`reference-dark` palette, density, 768-pixel conversation/composer column, compact breakpoint, and
paired desktop/compact fixtures. Implementations remain renderer-specific; no DOM component is
loaded by GPUIX.

Run structural parity tests through the normal package suites. Capture native reference evidence on
a supported Metal or DirectX host with `bun run capture:visual-parity`. Linux records screenshot
capture as explicitly unsupported while retaining structural evidence. Text antialiasing, native
scrollbars, and diagnostic overlays are excluded from image comparison. Before capture, the native
script requires the fixture automation marker to remain stable across consecutive observations; a
bounded timeout writes failed readiness evidence and exits unsuccessfully rather than publishing a
successful screenshot record.

The `gpuix-contract` CI matrix typechecks and tests both `gpuix-ui` and the product client on Linux,
macOS, and Windows. Portable contracts run everywhere, while supported Metal and DirectX jobs must
also make the native test renderer available.

The post-migration smoke profile on 2026-08-30 reported valid fixture equivalence, GPUIX retained
RSS growth of -1.82%, and a 66.23% process-tree RSS improvement over the virtual web reference. Its
overall verdict remains intentionally inconclusive because GPUIX still lacks presented-frame and
input-to-present evidence.

## Themes

GPUIX uses the same renderer-neutral named-theme registry as React. The initial
selectable theme is `one-dark`, which is also React's default. The native client
persists the selected name under the `theme` preference, validates stored values,
and falls back to `one-dark` when a value is missing or unsupported.

`reference-dark` remains reserved for deterministic parity fixtures. Components
read semantic colors from `GpuixUiProvider`; they do not import theme constants,
so subsequent React themes can be added to `@funny/ui-contracts` without
rewriting sidebar, conversation, composer, powerline, or status components.

## Dock layout

The expanded native shell composes navigation, files, and conversation with `DockLayout`. Drag the
thin named handle at the top of a panel to move it before or after a sibling. Drag a seven-pixel
separator to resize adjacent panels; navigation is constrained to 260–600 logical pixels, files to
240–600, and conversation retains a 400-pixel minimum.

Order and explicit sizes are stored under the `dock-layout` preference only when the mouse gesture
finishes. Invalid panel IDs, duplicate entries, malformed JSON, and out-of-range sizes are
normalized before use. Compact mode continues to hide navigation; returning to expanded mode
restores the saved layout. Existing two-panel preferences are migrated by inserting `Files` before
the conversation without changing the saved navigation width.

The `Files` dock appears by default at widths of 1100 logical pixels and above; the file button in
the thread header overrides that choice. It uses the same `/browse/files/index` source as React,
resolving the active worktree before the project root and letting the server resolve scratch-thread
directories. The index loads only while the dock is mounted, is capped at 10,000 paths, and renders
through the native virtual list. Folder expansion, case-insensitive filtering, refresh, selection,
empty, loading, truncated, and retry states are supported. Selecting a path currently highlights
it; native file preview/editor docks remain future work.

The native file tree sizes its retained React/native row window from the current viewport and then
refines it from GPUIX's reported visible logical range. It retains six overscan rows on each side
and requests 75 pixels of native overdraw. At the standard 900-pixel benchmark viewport, the
conservative first mount is 48 rows instead of the former fixed 96, and the subsequent visible-range
event can reduce it further while preserving direct scroll jumps and filtering anchors.
