# Client memory diagnostics

Funny configures the opt-in memory profiler provided by
`@abbacchio/browser-transport`. Abbacchio owns sampling, bounded retention, JSONL
export, and the console lifecycle API; Funny supplies its DOM selectors, Browser
Panel counters, and the metric sink that persists a run.

The profiler is installed in development builds and in any build where OTLP is
configured (`VITE_OTLP_ENDPOINT`), because a run is only worth keeping when there
is a sink to persist it into. It never starts sampling on its own.

The profiler cannot see all of Chrome's native memory. Use it together with
Chrome Task Manager to distinguish V8/DOM retention from canvas, image decoder,
and GPU/WebGL growth.

## Start a profile

Run Funny in development and open the browser DevTools console. The API is
installed as `window.__funnyMemory` but does not start a timer by itself:

```js
__funnyMemory.status();
__funnyMemory.start({
  intervalMs: 30_000,
  maxSamples: 1_440,
  label: 'baseline-idle',
});
```

At the default settings, the bounded history covers 12 hours. Starting a new
run clears previous samples unless `reset: false` is supplied.

`start()` and `status()` both return the run's `sessionId`. Record it — it is the
key that retrieves the run from Abbacchio later.

## Phase marks are automatic

While a run is active, Funny marks its own phase boundaries, so a long session
can be read back as phases without anyone typing in the console:

| Mark | Emitted from |
| ---------------------- | ----------------------------------------------------- |
| `thread-open` | `stores/thread-store.ts`, on thread selection |
| `browser-session-open` | `lib/browser-session-frames.ts`, on a session's first frame |
| `browser-session-close`| `lib/browser-session-frames.ts`, on retained-frame cleanup |
| `terminal-open` | `components/TerminalPanel.tsx`, once xterm is attached |
| `terminal-close` | `components/TerminalPanel.tsx`, before `terminal.dispose()` |

They go through `markMemoryPhase()` in [lib/memory-phase.ts](../../packages/client/src/lib/memory-phase.ts),
which is a no-op unless a run is active — so there is no cost when nobody is
profiling. Add a phase there rather than calling the global directly, and keep
the list short: every mark is a full sample.

Manual marks still work for anything the app cannot know about (`__funnyMemory.mark('my-phase')`).

Useful commands:

```js
__funnyMemory.mark('thread-open');
__funnyMemory.sample('manual-checkpoint');
__funnyMemory.getSamples().at(-1);
__funnyMemory.status();
__funnyMemory.stop();
__funnyMemory.download();
__funnyMemory.clear();
```

`download()` produces newline-delimited JSON (`.jsonl`) with one sample per
line. Samples contain counts and byte totals only; they do not contain message
text, frame contents, DOM nodes, or application store objects.

## Persist and query a run

Every sample is also published to Abbacchio as `client.memory.*` gauge metrics
(`lib/memory-telemetry.ts`), so a run survives the tab. Abbacchio stores the
points in its `metrics` table; `download()` remains the local, per-sample copy
with full per-session detail.

Persistence requires an OTLP endpoint. `VITE_OTLP_ENDPOINT` enables client
telemetry in development as well as production, so a local run is persisted with
no extra flag. Set `VITE_OTLP_ENABLED=false` to opt out.

Without an endpoint the profiler still works — samples simply stay in the page
and must be exported with `download()`.

Published series, one point per sample:

| Series | Source |
| ------------------------------------------------- | -------------------------------------------------- |
| `client.memory.heap.{used,total,limit}_bytes`      | Chrome heap readings, omitted when unavailable     |
| `client.memory.dom.*`                              | Element, canvas, image, xterm, Monaco, row, item counts |
| `client.memory.browser_panel.totals.*`             | Browser Panel frame and decode counters            |

Each point carries `sessionId`, `kind`, `sequence`, and `label` attributes.
Per-session Browser Panel entries (`values.browserPanel.trackedSessions`) are
deliberately not published, because one series per session id would grow metric
cardinality without bound; use the JSONL export for that detail.

To read a run back, query Abbacchio's database through `POST /api/sql`
(`GET /api/metrics` only returns the recent in-memory buffer):

```bash
curl -s localhost:4000/api/sql -H 'content-type: application/json' -d '{
  "sql": "SELECT datetime(time_unix_nano / 1000000000, '\''unixepoch'\'') AS at,
                 json_extract(attributes, '\''$.label'\'') AS label,
                 value / 1048576.0 AS used_mb
          FROM metrics
          WHERE name = '\''client.memory.heap.used_bytes'\''
            AND json_extract(attributes, '\''$.sessionId'\'') = '\''<session-id>'\''
          ORDER BY time_unix_nano"
}'
```

Do NOT use `curl` for these queries in this repository — the `rtk` shell hook
truncates its output and silently corrupts the JSON. Prefer the analysis script,
which ranks every series by post-GC floor movement and lists the phase marks:

```bash
bun .claude/skills/query-logs/analyze-memory.ts --list
bun .claude/skills/query-logs/analyze-memory.ts [sessionId]
```

The [Abbacchio memory profiling guide](https://github.com/ironmussa/abbacchio/blob/master/docs/memory-profiling.md)
has the remaining recipes: listing runs, ranking counters by growth, and
recovering phase marks.

## Controlled experiment

Use one Chrome tab and avoid opening DevTools panels other than Console/Memory
while a phase is running. In Chrome Task Manager (`Shift+Esc`), enable the
**Memory footprint** and **JavaScript memory** columns for the Funny tab.

The phase boundaries below are marked by the application, so the sequence only
requires performing the actions. Leaving a phase running longer than the minimum
is always better than cutting it short: a rising post-GC floor needs several
samples per phase before it means anything.

1. Reload Funny, wait for the initial page to settle, then start the profiler.
2. Leave Funny idle for 20–30 minutes.
3. Open a representative long-running thread and wait another 20–30 minutes
   without the Browser Panel.
4. Open the Browser Panel on a page with ordinary visual changes and leave it
   streaming for 20–30 minutes.
5. Record Chrome Task Manager values, explicitly close the Browser Panel
   session, and wait five minutes.
6. Exercise a terminal with representative output for 20–30 minutes, then close
   the terminal.
7. Stop the profiler. The run is already stored in Abbacchio; `download()` is
   only needed for the per-session detail that metrics omit.

Record Task Manager's two memory values at every phase boundary. The browser
does not expose renderer RSS reliably to page JavaScript, so these manual
measurements are the companion to the stored time series.

For retained-heap analysis, take a DevTools **Memory > Heap snapshot** after the
initial idle phase and another after the growing phase. Trigger garbage
collection immediately before each snapshot. Do not take periodic snapshots;
snapshotting is expensive and distorts a long-running profile.

## Counters

Each sample includes:

- `heap`: Chrome's `usedJSHeapSize`, `totalJSHeapSize`, and heap limit when
  available. Other browsers record `null`.
- `dom`: element, canvas, image, xterm, Monaco editor, virtual row, and rendered
  message-item counts.
- `values.browserPanel.totals`: cumulative frame count, base64 payload characters,
  decode starts/completions/failures, and pending decodes superseded by newer
  frames.
- `values.browserPanel.trackedSessions`: bounded per-session versions of the same
  counters.
- `values.workers`: Web Workers created, terminated, and live, per kind
  (`monaco:typescript`, `file-search`, …). Counts, not bytes.

## What these counters cannot see

`performance.memory` reports **only the main isolate's heap**. It excludes:

- **Worker heaps** — each worker is its own isolate. Monaco's `ts.worker` in
  particular can be large, and Monaco keeps workers alive after editors unmount.
- **WASM linear memory** — it grows and is never returned to the OS
  (`vendor/satteri-wasm32-wasi`, loaded inside a WASI worker).
- **Chrome-native allocations** — canvas backing stores, decoded images,
  GPU/WebGL, network buffers.

A tab whose process footprint climbs into the gigabytes while `heap.used_bytes`
stays flat is the signature of this blind spot, not of a healthy tab. This has
been observed: a session sat at ~2.8 GB in Chrome's Task Manager while the
profiler reported a flat ~320 MB heap with `canvases`, `images`, `xterms`,
`monaco_editors` and every `browser_panel` counter at zero.

`performance.measureUserAgentSpecificMemory()` is the one web API that reports the
whole renderer broken down by type, workers and WASM included — but it requires
cross-origin isolation, which needs `COEP: require-corp`. Funny deliberately runs
with `COOP: same-origin-allow-popups` to keep `window.opener` working (see
packages/server/src/index.ts), so that API is unavailable here. Use the
`values.workers` counts to spot a growing isolate population, and take a **heap
snapshot of the worker's own target** in DevTools > Memory to size it — the target
selector there lists each worker separately.

The base64 payload total is cumulative traffic, not retained memory. The most
useful Browser Panel signals are the rate of `framesReceived`, the gap between
`decodesStarted` and terminal outcomes, and `decodesSuperseded`.

## Interpretation

| Observation                                                    | Likely direction                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Post-GC JavaScript heap rises with stable DOM counts           | JavaScript objects or strings are retained; compare heap snapshot dominators and retainers |
| DOM elements/listeners rise with navigation                    | Mounted or detached component/listener lifecycle                                           |
| Memory footprint rises while JavaScript heap and DOM stay flat | Canvas backing stores, decoded images, network buffers, or GPU/WebGL memory                |
| Growth begins only during `browser-open`                       | Browser Panel frame/decode pipeline                                                        |
| Decode starts increasingly exceed completions/failures         | Image decode backlog or cancellation pressure                                              |
| Memory drops after closing the Browser Panel session           | Frame, image, or canvas resources associated with the session                              |
| Growth begins only with terminal output                        | xterm buffer or WebGL renderer path                                                        |

One rising measurement is not enough to call a leak. Compare slopes between
phases and prioritize values measured after the application has been idle long
enough for garbage collection.
