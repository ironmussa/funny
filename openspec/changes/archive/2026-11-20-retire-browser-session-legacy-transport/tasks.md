# Tasks

## 1. Protocol

- [x] 1.1 Add `viewport`, `navigated`, `controller`, `dialog`, `agent_opened` and `pointer` payloads to `BrowserSessionMessage` and `viewport` / `controller` to `BrowserSessionReady` in `protocol/browser/v1/interactive.proto`; verify `bun run protocol:lint` and `bun run protocol:breaking` pass
- [x] 1.2 Regenerate `browser.v1` code and the schema fingerprint; verify `bun run protocol:generate:check` passes
- [x] 1.3 Add round-trip fixtures for each new payload; verify `bun run protocol:fixtures:test` passes

## 2. Server mapping

- [x] 2.1 Map every `browser-session:*` type in `browserSessionPublication` (`services/browser-events.ts`) to its payload and the delivery class from design.md, so no browser-session type falls through to `toUser`; verify with a unit test per type asserting payload case, delivery class and coalescing key
- [x] 2.2 Unit test that an unknown `browser-session:*` type is dropped and logged, not sent as a legacy event

## 3. Client decoder

- [x] 3.1 Decode each new payload case in `hooks/use-ws.ts` into `dispatchRealtimeEvent('browser-session:<type>', '', data)` with the legacy data shape; verify with a test that feeds encoded envelopes and asserts the `dispatchBrowserSessionEvent` calls
- [x] 3.2 On `onRecoveryRequired` for the user scope, re-attach the panel's thread session; verify with a store test
- [ ] 3.3 Validate in dev with `FUNNY_BROWSER_V1_BROWSER_SESSION=binary`: panel attach (no stuck "Spawning Chrome…"), agent cursor, URL following, dialog, take over / hand back, reconnect and polling fallback; record the result in this file
  - 2026-11-05, dev (browser.v1 always on): validated with the user — panel attaches without a stuck "Spawning Chrome…", agent cursor visible, URL bar follows the page, page audio starts muted, the audio toggle and Stop work, no 429 while a video plays. Found and fixed on the way: stale schema fingerprint after a hot reload (now a reload notice), frames exhausting the API rate limit, AudioContexts auto-running, Chromium restoring tabs after an abrupt stop. Not yet validated: dialogs, take over / hand back, reconnect and polling fallback.

## 4. Remove the legacy path

- [x] 4.1 Make `selectRepresentation` return `BROWSER_V1` for the `browserSession` class; remove `browserSession` from `BrowserV1RolloutConfig` and `FUNNY_BROWSER_V1_BROWSER_SESSION`, warning once at startup if it is still set; update the rollout and sink tests
- [x] 4.2 Remove the `browser-session:*` entries from `ALL_EVENT_TYPES` and the handler table in `hooks/ws-event-dispatch.ts`; verify `bun run typecheck` and the client tests pass
- [x] 4.3 Update `docs/browser-v1-transport.md` (feature controls, compatibility window) and the OpenWiki operations page; verify the docs link check passes

## 5. Integration

- [x] 5.1 Run `bun run lint`, `bun run typecheck` and the browser-tools integration test (`packages/runtime/src/__tests__/services/browser-tools.integration.test.ts`)
- [ ] 5.2 E2E: Playwright run of the browser panel suite against WebSocket and polling transports
