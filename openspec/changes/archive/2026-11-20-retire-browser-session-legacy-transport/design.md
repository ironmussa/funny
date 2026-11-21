# Design

## Context

- Runners publish browser-session events as `runner.v2` user events. The server relays them (`grpc/events-handler.ts` → `browser-events.ts`). This leg is unchanged.
- `browserSessionPublication` in `browser-events.ts` builds a `browser.v1` interactive envelope only for `frame`, `ready`, `result`, `console`, `error` and `closed`. For any other type it returns `null`, and the event falls through to `browserEvents.toUser(...)`, a legacy JSON emit to the user room.
- `BrowserEventSink.publish` chooses a representation per socket from the negotiated assignments (`browser-v1-rollout.ts`, `FUNNY_BROWSER_V1_BROWSER_SESSION`, default `legacy`). So today the panel receives _everything_ as legacy JSON. The `browser.v1` decode branch in `use-ws.ts` (`payload.case === 'browserSession'`) is unused in practice.
- The client already negotiates `BROWSER_SESSION` as a capability on every connect and subscribes to the user scope.
- `dispatch-browser-session-events.ts` is the single client handler for browser-session state. Today it is fed by both the legacy `socket.on` registrations and the `use-ws.ts` decoder.

## Goals / Non-Goals

**Goals:**

- One representation, one route and one order for all browser-session messages from server to client.
- The decoder produces the same `dispatchBrowserSessionEvent(type, data)` calls the legacy path produces, so the panel store and components do not change.

**Non-Goals:**

- Client → server browser-session requests (open, navigate, input, …). They already go through typed operations and interactive messages. If a legacy request emit is found during implementation, it is removed in this change only when it has a typed equivalent; otherwise it is listed for a later phase.
- Retiring legacy for operations, events or terminal.
- Native gRPC clients.

## Decisions

### Additive proto fields, not a new message version

Add `viewport`, `navigated`, `controller`, `dialog`, `agent_opened` and `pointer` as new `oneof payload` cases in `BrowserSessionMessage`, and add `viewport` / `controller` fields to `BrowserSessionReady`. All of these are additive under `browser.v1` and pass `protocol:breaking`. A `browser.v2` would be needed only for incompatible semantics, and there are none.
_Alternative_: a generic JSON `Struct` payload for "other" events. Rejected: it reintroduces untyped legacy semantics inside the typed carrier and defeats fixtures.

### Delivery classes

| Payload                                    | Class                                         | Coalescing key                           |
| ------------------------------------------ | --------------------------------------------- | ---------------------------------------- |
| frame                                      | coalescible                                   | `browser-frame:<session>` (existing)     |
| pointer                                    | volatile                                      | —                                        |
| viewport, navigated, controller            | coalescible                                   | `browser-<kind>:<session>` (latest wins) |
| ready, dialog, agent_opened, close, result | snapshot-recoverable                          | —                                        |
| console                                    | volatile (existing)                           |
| status/error                               | snapshot-recoverable, priority 100 (existing) |

`ready` carries the full restorable state (URL, viewport, controller), and the runner re-sends `dialog` on attach. So a panel that loses coalescible messages recovers on its next attach.

### Ordering

All browser-session payloads go through one outbound queue per connection and traffic class (`browserSession`), so they cannot overtake each other. Today they can: `ready` goes through `publish` and `viewport` through `toUser`. Replacement or dropping only applies to the classes declared droppable.

### Representation is fixed for this class

`selectRepresentation` returns `BROWSER_V1` for `trafficClass === 'browserSession'` without consulting the assignments. `BrowserV1RolloutConfig` loses its `browserSession` field, and the server no longer reads `FUNNY_BROWSER_V1_BROWSER_SESSION`; if it is still set, the server logs one warning at startup. A socket that did not negotiate `browser.v1` gets no browser-session events (see spec). The client already negotiates on every connect, so this only affects incompatible clients.
_Alternative_: keep the env var but ignore `legacy`. Rejected: a setting that does nothing is misleading.

### Client

`use-ws.ts` maps each new payload case to `dispatchRealtimeEvent('browser-session:<type>', '', data)` with the same data shape the legacy event had, so `dispatch-browser-session-events.ts` keeps one code path. `ws-event-dispatch.ts` drops the `browser-session:*` entries from `ALL_EVENT_TYPES` and from the handler table. The `BROWSER_V1_SCHEMA_FINGERPRINT` is regenerated.

## Risks / Trade-offs

- [Clients without the new decoder lose the panel after the server deploys] → Server and client ship in the same Railway service (`funny-server` serves the SPA), and a reload picks up the new client. Open tabs show the panel as disconnected until they reload.
- [No runtime rollback for this class] → Rollback is redeploying the previous server+client build. Accepted, because the legacy path is what we are deleting. Verify the binary path in staging first with `FUNNY_BROWSER_V1_BROWSER_SESSION=binary` on the current build, before the change lands.
- [Frame payloads already use HTTP resource references; a resource fetch failure now hides frames] → Existing `browser.v1 frame resource unavailable` warning, plus the 8 MiB / 64 MiB budgets. Add a metric for failed frame fetches if one is missing.
- [Queue exhaustion of snapshot-recoverable messages] → Already reported as `RESOURCE_EXHAUSTED`. The client handles the panel's recovery by re-attaching (`attachThreadSession`) on `onRecoveryRequired` for the user scope.

## Migration Plan

1. Land proto + server mapping + client decoder while legacy still exists, and validate in dev/staging with `FUNNY_BROWSER_V1_BROWSER_SESSION=binary`: panel attach, agent cursor, navigation, dialogs, take over / hand back, reconnect, polling fallback.
2. Remove the legacy selection, the env var and the client legacy handlers in the same PR, once step 1 passes.
3. Deploy `funny-server` on Railway (server + SPA together). The runner does not need a deploy.
4. Rollback: redeploy the previous `funny-server` build.
