## Socket Payload Inventory

Inbound socket payload surfaces found during task 5.1:

### Server Socket.IO

- `packages/server/src/services/socketio/router.ts`
  - `registerSocketHandlersWithSchema` and `registerSocketRpc` now parse inbound `data` with `parseSocketPayload(schema, data)` before calling handlers.
  - `registerSocketHandlers` remains as a compatibility wrapper over `socketObjectPayloadSchema` for object-only forwarded payloads.
  - RPC handlers can provide `invalidPayloadResponse` so malformed ack-based payloads do not hang callers.

- `packages/server/src/services/socketio/thread-presence.ts`
  - `THREAD_OPEN_EVENT` and `THREAD_CLOSE_EVENT` already validate with shared `threadOpenSchema.safeParse(raw)`.
  - This is an accepted pattern and should become the reference shape for event-specific schemas.

- `packages/server/src/services/socketio/runner-events.ts`
  - `RUNNER_AGENT_EVENT` validates through `parseRunnerAgentEvent(data)`.
  - `RUNNER_BROWSER_RELAY` validates through `parseRunnerBrowserRelay(data)`.
  - Both parsers live in `packages/shared/src/socket-events.ts` and are accepted shared-schema patterns.

- `packages/server/src/services/socketio/runner-data.ts`
  - Registers runner data RPC events with `data: unknown` and `ack`.
  - Validates the shared envelope with `parseRunnerDataRequest(data)`, including `_requestId`.
  - Per-event `payload` schemas remain future migration debt if these data events become stricter.

### Runtime Socket.IO Client

- `packages/runtime/src/services/team-client.ts`
  - `tunnel:request`, `data:response`, `central:browser_ws`, `central:pty_list`, and `central:command` parse inbound payloads with shared schemas from `packages/shared/src/socket-events.ts`.
  - `sendDataMessage(eventType, payload)` emits outbound data envelopes with `_requestId`; outbound payload typing exists in function signatures but does not validate inbound responses.

### Runtime Local Socket

- `packages/runtime/src/services/pty-daemon.ts`
  - Reads NDJSON from a Unix socket, parses with `JSON.parse(line) as DaemonCommand`, then switches on `msg.cmd`.
  - Next step: add a `DaemonCommand` Zod schema or discriminated union before `handleCommand`.

### Existing Shared Socket Schemas

- `packages/shared/src/socket-events.ts`
  - Contains `parseSocketPayload`, `socketObjectPayloadSchema`, `browserPtyForwardPayloadSchema`, runner control schemas, runner event parsers, central-to-runner schemas, and event schemas such as `threadOpenSchema`.
  - This is the preferred location for payload schemas used by both server and runtime.

### Enforcement

- `scripts/fitness/check-socket-boundary-validation.ts`
  - Flags new direct `socket.on(... data/raw: unknown|any ...)` handlers without a nearby parse helper or `schema.safeParse`.
  - Flags new `registerSocketRpc` handlers that consume a third payload argument without `payloadSchema` or an explicit parser.
  - Baseline: `.fitness/socket-boundary-validation-baseline.txt`, currently `0` violations.
