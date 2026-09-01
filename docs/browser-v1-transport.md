# browser.v1 transport operations

`browser.v1` is the versioned browser application contract carried as Protobuf binary attachments over the existing authenticated Socket.IO namespace. It does not add a public port, proxy, parser, or second realtime connection.

## Deployment behavior

- Local and self-hosted web clients keep same-origin cookies, CORS/CSRF checks, WebSocket upgrade, and polling fallback.
- Packaged clients keep the endpoint selected by the existing client endpoint policy. The client descriptor reports its host mode for cohort selection.
- Managed deployments use the same namespace and may select cohorts by deployment and cohort identifiers.
- Runner credentials and `runner.v2` messages are never exposed to browser clients. Browser authorization is re-evaluated for each operation, subscription, terminal, browser-session, and HTTP resource reference.

## Feature controls

Every traffic class defaults fail-closed to `legacy`. Accepted values are `legacy`, `shadow`, and `binary`:

```text
FUNNY_BROWSER_V1_OPERATIONS
FUNNY_BROWSER_V1_EVENTS
FUNNY_BROWSER_V1_TERMINAL
FUNNY_BROWSER_V1_BROWSER_SESSION
```

`FUNNY_BROWSER_V1_DEPLOYMENTS` and `FUNNY_BROWSER_V1_COHORTS` are optional comma-separated allowlists. Shadow mode encodes and measures the typed payload but dispatches only legacy state. A logical message is never dispatched through both representations.

Rollback is independent per traffic class: set only the affected class to `legacy` and restart the server. Authoritative state and retained idempotency outcomes survive representation changes. At-most-once terminal and browser input is never replayed during rollback.

## Recovery and budgets

- Retained durable events: 5 minutes and 4 MiB per scope. An unavailable cursor returns an explicit gap or snapshot-required outcome.
- Event client state: bounded event-ID deduplication, monotonic revisions, scoped cursors, and targeted user/thread refresh.
- Outbound queues: 256 messages and 4 MiB per connection and traffic class, four concurrent sends, plus 16 reserved control messages. Coalescible/volatile messages may be replaced or dropped; durable exhaustion produces `RESOURCE_EXHAUSTED` and requires resynchronization.
- Terminal output: live-only at the browser carrier. Runner output remains ordered and resumable at the runner stream; a browser sequence gap is explicit and triggers terminal recovery. Terminal input ordinals are retained for 10 minutes and are never implicitly replayed.
- Browser frames: at most 8 MiB each, 64 MiB total, 30-second retention. Socket.IO carries only an authorized same-origin reference; the HTTP response is principal-scoped, `no-store`, size bounded, and content-type protected.

## Diagnostics and acceptance

Payload-safe `browser.v1` metrics and structured logs cover negotiation, representation, transport, decode rejection, operation latency/status, payload size, queue depth/drop/exhaustion, gaps, snapshots, and resource failures. They intentionally exclude cookies, credentials, principals, resource IDs, request bodies, and payload content.

Before widening a cohort, compare the thresholds in `protocol/browser/v1/acceptance.json` and require:

- no state double-application or authorization disclosure;
- accepted failure, timeout, reconnect, gap, latency, memory, and queue-exhaustion rates;
- WebSocket and polling parity, including reconnect;
- bounded memory under terminal/browser-frame pressure;
- immediate independent rollback for the selected class.

Useful checks:

```bash
bun run protocol:lint
bun run protocol:breaking
bun run protocol:generate:check
bun run protocol:fixtures:test
bun run protocol:browser-v1:benchmark
bun run lint
bun run typecheck
```

## Compatibility window

Legacy Socket.IO representations remain supported for the entire `browser.v1` release line and cannot be retired by this change. A custom Socket.IO parser, native WebSocket transport, native gRPC adapter, changed compatibility window, or legacy retirement requires a separate reviewed OpenSpec change with browser/WebView and production soak evidence.
