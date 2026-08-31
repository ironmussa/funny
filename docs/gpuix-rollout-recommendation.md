# GPUIX rollout recommendation

## Recommendation

Keep GPUIX opt-in and experimental. Do not replace the React DOM default yet. The native MVP is
functionally useful and its renderer benchmark shows a large local RSS advantage, but the evidence
does not support a general performance claim or broad credential/accessibility rollout.

## Evidence available through 2026-08-30

- Renderer-neutral fixtures contain two ordered 500-message histories with equivalent Markdown,
  code, table, tool-call, and diff inventory.
- The controlled product-shell comparison at `2026-08-24T04-32-43.710Z` reported 67.13 percent
  lower idle process-tree RSS and 59.18 percent lower idle process-tree CPU for GPUIX than React DOM
  on this one Linux x64 machine.
- Repeated-navigation retained RSS was noisy before stabilization because the first batch warmed the
  renderer allocator and second-thread capacity. With an identical 100-switch stabilization pass in
  both renderers, the following four GPUIX samples were 1.13, 5.03, 3.74, and 2.47 percent; their
  3.10 percent median passed the 5 percent memory gate.
- The controlled comparison remains `inconclusive` for presentation-based gates because it used
  GPUIX 0.4.0 and GPUIX still has no verified presented-frame boundary. This does not mean that
  current GPUIX lacks paint diagnostics.
- GPUIX 0.5.1 exposes visible painted-row bounds plus aggregate overlay statistics (`current`, p90,
  p99, maximum, total frames, and sample count). Product-profile runs now persist those values as
  renderer-specific workload diagnostics. They measure native layout/draw cost, not GPU memory or
  input-to-present latency.
- Product contract, state, auth, realtime, workflow, recovery, and 500-message tests pass locally.
  The native renderer smoke is capability-gated and was unavailable in the current test runtime.
- A process-isolated integration test now starts a real local Funny server and verifies native
  sign-in, persisted session restoration, authenticated REST, Socket.IO, and server-side session
  expiry against a temporary SQLite database.
- The packaged release was extracted outside the workspace, installed from its declared
  dependencies, and passed a native process/window-liveness smoke on glibc Linux x64. Other release
  hosts remain unverified locally.

These numbers describe a single controlled machine and pinned dependency stack. They are not a
universal CPU, GPU, latency, or memory guarantee.

## Rollout blockers

1. Run the product-client adapter and release smoke on macOS, Windows, and Linux arm64; the 5 percent
   memory gate has passed only on this Linux x64 machine.
2. Obtain a public GPUIX presentation acknowledgement before using frame-by-frame or
   input-to-present gates; continue using the existing overlay aggregates for draw-cost diagnosis.
3. Obtain secure-text input before recommending native credential entry outside trusted local use.
4. Obtain accessibility-label/screen-reader primitives and complete an assistive-technology review.
5. Complete release artifact and native-window smokes on every supported host.

The rollback is immediate: omit `--renderer=gpuix` or run `bun run dev:client`. The web renderer,
browser storage, and server data remain unchanged.
