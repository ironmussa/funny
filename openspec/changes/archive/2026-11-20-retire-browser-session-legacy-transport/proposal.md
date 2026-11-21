# Proposal

## Why

The browser panel's session traffic travels through two representations at once: `frame`, `ready`, `result`, `console`, `error` and `closed` can use `browser.v1`, while `viewport`, `controller`, `dialog`, `agent-opened`, `pointer` and `navigated` exist only as legacy Socket.IO JSON events. Every traffic class defaults to `legacy`, so `browser.v1` for browser sessions is never exercised. Keeping both paths doubles the client handlers. It also lets the messages of one session take different routes, so their relative order is not guaranteed. The agent cursor (`pointer`) and URL following (`navigated`) were just added and exist only as legacy events, so the gap keeps growing. Now is the time to make one typed path the only one, starting with the browser-session class that the panel depends on.

## What Changes

- Extend `protocol/browser/v1/interactive.proto` `BrowserSessionMessage` with typed payloads for `viewport`, `controller`, `dialog`, `agent_opened`, `pointer` and `navigated`. `ready` also carries the viewport and controller, so one message restores a re-attaching panel.
- Map every runner `browser-session:*` event to a `browser.v1` interactive envelope in `packages/server/src/services/browser-events.ts`, each with an explicit delivery class: `pointer` volatile; `frame` coalescible; `viewport`, `navigated` and `controller` coalescible per session; `ready`, `dialog`, `agent_opened`, `close` and `result` snapshot-recoverable.
- **BREAKING**: The `browserSession` traffic class is always dispatched as `browser.v1`. Remove its legacy and shadow selection and the `FUNNY_BROWSER_V1_BROWSER_SESSION` environment variable. Browser-session events are never sent as legacy JSON events.
- **BREAKING**: The web client decodes every browser-session payload in `use-ws.ts` and no longer registers legacy `socket.on` handlers for `browser-session:*` events. A client older than the server loses the browser panel until it reloads.
- Out of scope: the `operations`, `events` and `terminal` traffic classes keep their current rollout controls. They are later phases.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `browser-v1-transport`: The browser-session traffic class leaves reversible migration. It is delivered only through `browser.v1`, and its message set covers every browser-session event the panel consumes.

## Impact

- Protocol: `protocol/browser/v1/interactive.proto`, generated code in `packages/shared/src/generated/browser-v1`, schema fingerprint, protocol fixtures and `protocol:breaking` (additive fields; the removed representation is server/client behavior, not wire).
- Server: `services/browser-events.ts`, `services/socketio/browser-event-sink.ts` (representation selection for `browserSession`), `services/socketio/browser-v1-rollout.ts`, `docs/browser-v1-transport.md`.
- Runtime: none. Runner events stay `runner.v2` user events.
- Client: `hooks/use-ws.ts` (decode the new payloads), `hooks/ws-event-dispatch.ts` (drop the `browser-session:*` legacy registrations), `hooks/dispatch-browser-session-events.ts` (stays the single handler, fed by the decoder).
- Deployment: server and client must ship together on Railway (`funny-server` serves the client). No runner deploy is required.
