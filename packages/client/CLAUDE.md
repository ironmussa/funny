# packages/client — CLAUDE.md

## Logging & Telemetry

**Always send logs to Abbacchio.** When adding new functionality, error handling, or debug output, use the existing client-side logger and telemetry utilities so that logs, metrics, and traces are sent to Abbacchio via OTLP.

- **Logs:** Use `createClientLogger(namespace)` from `@/lib/client-logger.ts` (`@abbacchio/browser-transport`). Create a namespaced logger per module/store.
- **Metrics/Traces:** Use `metric()` and `startSpan()` from `@/lib/telemetry.ts` for recording metrics and traces with W3C Trace Context propagation.
- Do NOT use bare `console.log` / `console.error` — always prefer the structured logger so output reaches Abbacchio.
- When creating new stores, hooks, or significant UI interactions, add relevant log calls and spans (e.g., API call duration, user action traces).

### Log levels are PERMANENT — do not add/remove logs per investigation

Instrumentation is supposed to be a fixed fixture of the code, not something you sprinkle in for one debug session and rip out afterwards. The level system below exists so you can leave detail in place and toggle visibility at runtime instead.

**Level policy — choose by frequency, not by "how important is this right now":**

- `error` / `warn` — unexpected failure paths. **Always on** in prod. Never gate behind any flag.
- `info` — milestones that should be visible per session: WS connect, transport name, `agent:result` received, route changes, auth state changes. **Always on** in prod. Default ship level.
- `debug` — high-frequency / noisy traces: every WS chunk, every RAF flush, every status transition, queue dedups, render cycles. **Off in prod by default**, toggled at runtime via localStorage (see below).
- `trace` — extreme detail (per-keystroke, per-frame). Reserved; use sparingly.

**Default level**: `info` in prod (`import.meta.env.PROD === true`), `debug` in dev. This is set inside `client-logger.ts` — do NOT change it. If you find yourself wanting to "promote" a debug log to info so it shows up in prod, that's a sign it's a milestone — pick the right level once and leave it.

**Runtime toggles (work in prod, no redeploy):**

```js
// In DevTools console:
__funnyLog.setLevel('debug'); // raise global floor
__funnyLog.setNamespaceLevel('ws', 'debug'); // raise just one namespace
__funnyLog.clear(); // reset to defaults
```

Or via localStorage directly:

- `funny:log-level` — global floor (`trace|debug|info|warn|error|fatal`)
- `funny:log-ns:<namespace>` — per-namespace override (e.g. `funny:log-ns:ws=debug`)

**Do not introduce new toggle keys or rename these.** Other agents / scripts / runbooks depend on them.

### Metric / log decision rule

- High-frequency event you want to see **always** (every result, every WS connect, every API call) → **metric**, NOT a log. Metrics are orders of magnitude cheaper than logs and graphable in Abbacchio.
- Causal chain across async boundaries (WS event → store applied) → **span** via `startSpan()`. Don't bracket it with two log lines.
- Discrete milestone or unexpected condition → `info` / `warn` / `error` log.

**Rule of thumb**: if the line would say "X happened with value Y", it's probably a metric (`metric('x', y, { attributes: {...} })`), not a log.

### Permanent instrumentation points — do not remove

These exist specifically to diagnose production-only issues without redeploying. If you're refactoring the surrounding code, KEEP these in place:

- `ws.connected` (counter, attr `transport`) — emitted on every Socket.IO connect in `hooks/use-ws.ts`. Surfaces reverse-proxy WS-upgrade failures (`transport=polling` is the smoking gun for dropped trailing events).
- `ws.transport_upgrade` (counter, attr `transport`) — emitted when polling upgrades to websocket. Missing samples = upgrade never happened.
- `ws.result_received` (counter, attr `status`) — emitted in `hooks/ws-event-dispatch.ts` for every `agent:result`. Lets us distinguish "event never arrived" from "event arrived but store didn't apply".
- `ws.dispatch_result` (span, attr `status`) — wraps the result→store-applied path. Surfaces React 19 transition lag.
- `review.refresh_outcome` (counter, attrs `outcome` = applied|superseded|aborted|error, `files`, `threadId`) — emitted in `hooks/use-diff-data.ts` for every Changes-tab diff-summary refresh. Distinguishes "the Changes tab showed no changes because the fetch returned 0 files" (`outcome=applied files=0`) from "the fetch succeeded but the result was discarded by the epoch/abort guard" (`outcome=aborted|superseded`) — the two ways the review pane can wrongly render "No changes" on a dirty tree.
- `review.reset_gate` (counter, attrs `decision` = refresh|defer|skip-branch-hydration, `contextChanged`, `threadId`) — emitted in `hooks/use-review-state.ts` in the context-change reset effect, the primary refresh trigger on thread/project switch. If a switch shows a stale "No changes": no `reset_gate` sample for that switch ⇒ the effect never ran (gitContextKey didn't change — the right pane is following a different thread id, e.g. `liveColumnsOpen` grid selection); `decision=defer` ⇒ `reviewPaneOpen` was stale-false so the refresh was skipped.

- `thread.scroll_restore` (counter, attr `outcome` = bottom|anchor|progress|skipped) — emitted in `components/thread/MessageStream.tsx` once per thread switch when the saved scroll position is applied. Diagnoses "thread reopens at the wrong scroll position": a stream of `progress` outcomes for a thread the user always leaves at the bottom means the saved position is being corrupted again (see the settle-window logic in MessageStream — scroll events during the post-switch settle window must NOT be persisted).

If you add a new always-on metric/span that diagnoses a class of prod issue, add it to this list so the next agent doesn't delete it.
