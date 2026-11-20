## 1. Persisted Thread Permission Mode

- [x] 1.1 Add an owner-authorized thread endpoint and validation schema that update only an existing thread's `permissionMode`.
- [x] 1.2 Emit the normal thread-update WebSocket event after a successful mode update and ensure all thread-store projections apply it.
- [x] 1.3 Add a client API method and optimistic thread-store mutation with rollback/error handling for a failed update.
- [x] 1.4 Replace the prompt selector's local-only setter with a persistence-aware setter for existing threads while retaining local defaults for new threads.
- [x] 1.5 Add route tests for validation, persistence, and update emission.
- [x] 1.6 Add client tests that prove synchronized projections and rollback after an API failure, plus a route reload check for persistence.

## 2. Structured Permission State

- [x] 2.1 Define shared types for transport permission capability, structured permission request, supported decisions, and stale-request errors.
- [x] 2.2 Add additive database schema and repository methods for one active pending permission request per thread/run, including resolution and expiration state.
- [x] 2.3 Extend thread detail/status payloads and WebSocket data with sanitized structured pending-permission state and resolved transport capability.
- [x] 2.4 Replace Codex-specific reconstruction from error text with structured state when a transport advertises structured approval capability.
- [x] 2.5 Add repository and serialization tests for active, resolved, expired, and historical/no-request thread states.

## 3. ACP Continuation Support

- [x] 3.1 Extend the provider-agnostic agent process/runner contract with an optional response operation for a live permission request.
- [x] 3.2 Change `GenericACPProcess` to register a resolver for `session/request_permission`, emit a structured request, and await a direct decision instead of using a synthetic denial plus abort.
- [x] 3.3 Implement exact ACP option selection for allow once, allow always, and deny, including providers that omit an optional always/reject option.
- [x] 3.4 Wire the runtime agent registry to route a request-id response to the current process and reject process/run mismatches.
- [x] 3.5 Add Generic ACP unit tests for request emission, direct allow/deny resolution, sequential requests, stale ids, and process exit while waiting.

## 4. Codex Transport and Runtime Approval Flow

- [x] 4.1 Add `FUNNY_CODEX_TRANSPORT=sdk|acp` resolution with SDK as the default and clear startup failure when selected ACP is unavailable.
- [x] 4.2 Route ACP-selected Codex executions through `CodexACPProcess` and advertise its structured permission capability; advertise unavailable approval capability for the SDK transport.
- [x] 4.3 Refactor the structured approval route to require request id and decision, authorize the thread owner, persist state transitions, and directly resume the live ACP request without `startAgent`.
- [x] 4.4 Keep the legacy heuristic approval path only for unaffected providers; ensure Codex SDK permission-like failures produce provider recovery rather than an actionable approval or generic `Continue` card.
- [x] 4.5 Implement `allow always` as an atomic-or-safe sequence with project-rule persistence; keep the request actionable when persistence fails and never claim a permanent approval was saved.
- [x] 4.6 Expire pending structured requests on runner/process loss and surface an explicit recovery/retry state instead of reconstructing a request from tool-call history.
- [x] 4.7 Add runtime integration tests for direct one-time approval, always-rule persistence/failure, denial, stale submissions, runner loss, SDK fallback UX data, and ACP transport selection.

## 5. Permission UI

- [x] 5.1 Update thread status state and message-stream components to render a structured approval card only for an active structured request.
- [x] 5.2 Add the Codex SDK unavailable-approval recovery card and prevent it from using the generic waiting `Continue`/reject controls.
- [x] 5.3 Pass request id and explicit decision from the approval card to the new runtime API; disable/refresh the card after a stale-response conflict.
- [x] 5.4 Preserve the existing tool input presentation while using only the sanitized persisted input for structured requests.
- [x] 5.5 Add localization for transport-specific recovery, stale approval, runner-loss, and always-rule persistence failure states.
- [x] 5.6 Add component and browser-level tests for precise card content, repeated approvals, unavailable SDK recovery, stale clicks, and permission-mode persistence.

## 6. Rollout and Verification

- [x] 6.1 Add runner configuration documentation for selecting Codex SDK or ACP and describe the approval capability difference.
- [x] 6.2 Run the focused client, runtime, core, shared, and route test suites.
- [ ] 6.3 Manually smoke-test a real `codex-acp` runner with two sequential approvals, deny, always allow, navigation/reload, and runner restart.
- [x] 6.4 Run `bun run lint`.
- [x] 6.5 Run `bun run typecheck`.
