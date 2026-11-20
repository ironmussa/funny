## 1. Package and Renderer Selection

- [x] 1.1 Re-audit the pinned GPUIX versions, public host APIs, native binary matrix, and presentation telemetry before implementation starts
- [x] 1.2 Add the private `@funny/client-gpuix` workspace package with DOM-free TypeScript and pinned React/GPUIX dependencies
- [x] 1.3 Add development-only access to shared benchmark fixtures and contracts without importing benchmark orchestration into the product runtime
- [x] 1.4 Add release build and start commands for the native package with one React instance and correctly externalized GPUIX native modules
- [x] 1.5 Add explicit experimental renderer selection while preserving React DOM as the default launch path
- [x] 1.6 Add deterministic supported-host probing and an actionable fallback result for incompatible OS/architecture combinations
- [x] 1.7 Extend layering validation to reject DOM, browser, Tauri, React DOM, and web-component imports from native domain modules

## 2. Native Platform Composition

- [x] 2.1 Extend the renderer-neutral host-mode contract with a native variant and prove existing browser/Tauri resolution remains unchanged
- [x] 2.2 Implement per-user native application-data path resolution for every initially supported host
- [x] 2.3 Implement atomic native key/value persistence with read, write, remove, subscription, malformed-value recovery, and redacted failures
- [x] 2.4 Implement a bounded session store that never persists submitted passwords and enforces user-only access where persistence is enabled
- [x] 2.5 Implement in-memory native navigation using the canonical Funny path parser and observable location changes
- [x] 2.6 Implement native HTTP requests with normalized responses, cancellation, endpoint selection, and remote-origin validation
- [x] 2.7 Implement the native cookie/session jar and authentication propagation without leaking session material into logs or diagnostics
- [x] 2.8 Implement GPUIX lifecycle signals for focus and visibility with deterministic subscription cleanup
- [x] 2.9 Implement native semantic effects and structured unsupported-effect diagnostics
- [x] 2.10 Create and validate the GPUIX `ClientPlatform` composition before any auth, realtime, or renderer initialization
- [x] 2.11 Add contract tests for every native platform service plus missing-capability and storage-failure behavior

## 3. Portable Vertical State Slices

- [x] 3.1 Inventory the exact auth, project, thread, prompt, run, permission, and realtime behavior required by the MVP and map each behavior to its current canonical implementation
- [x] 3.2 Add a renderer-neutral auth/session state factory with bootstrap, authenticated, rejected, and logout transitions
- [x] 3.3 Add portable accessible-project and grouped-thread navigation state with scratch and shared thread support
- [x] 3.4 Add portable selected-thread state with canonical message, tool-call, pagination, run, and pending-permission identities
- [x] 3.5 Add deterministic merge operations for initial pages, older pages, durable updates, streaming deltas, and late or duplicate events
- [x] 3.6 Add portable prompt submission, stop, resume, and permission-response actions with single-flight and idempotency guards
- [x] 3.7 Add renderer-neutral selectors that avoid rerenders from unrelated thread and project updates
- [x] 3.8 Adapt existing web consumers only where necessary to prove shared state behavior without changing the current UI contract
- [x] 3.9 Add parity and regression tests covering the portable slices and their web compatibility adapters

## 4. Authentication and Realtime Services

- [x] 4.1 Implement native session restoration and profile bootstrap through the existing authentication endpoints
- [x] 4.2 Implement native credential sign-in, rejected-session cleanup, logout, and non-persistent-session operation
- [x] 4.3 Implement the native Socket.IO connection using the resolved server origin and current authenticated session
- [x] 4.4 Connect native incoming events to the shared realtime dispatcher and portable state actions without browser event APIs
- [x] 4.5 Implement reconnect, focus resync, active-thread eligibility, throttling, and deterministic connection disposal
- [x] 4.6 Add stale and duplicate realtime-event protection for messages, tool calls, run state, and permission requests
- [x] 4.7 Add integration tests against a local Funny server for sign-in, session restoration, authenticated REST, realtime connection, and expiry

## 5. Read-Only Native Application Shell

- [x] 5.1 Build native bootstrap, login, authenticated, recoverable-error, and unsupported-host root states
- [x] 5.2 Build the bounded sidebar with accessible projects, project threads, scratch threads, shared threads, and active-state indicators
- [x] 5.3 Connect sidebar selection to native navigation, protected-resource cleanup, and selected-thread loading
- [x] 5.4 Build the native thread header with canonical title, project context, connection state, and run status
- [x] 5.5 Build stable message rows for user, assistant, Markdown, code, table, tool-call, and diff content
- [x] 5.6 Build explicit typed fallback rows for unsupported or malformed message features without omitting textual payloads
- [x] 5.7 Implement variable-height virtualized history with stable row identities, bounded retention, and scroll continuity
- [x] 5.8 Implement older-page loading without duplicate messages, reordered rows, or unintended scroll jumps
- [x] 5.9 Add native loading, empty, access-denied, disconnected, and retry presentations
- [x] 5.10 Add fixture inventory, ordering, checksum, and 500-message virtualization tests for the read-only shell

## 6. Prompt, Agent Controls, and Permissions

- [x] 6.1 Build the native prompt composer with multiline editing, submit eligibility, pending state, and duplicate-submit prevention
- [x] 6.2 Connect prompt submission to the existing thread API and reconcile optimistic state with server-confirmed message identity
- [x] 6.3 Render streaming assistant and tool-call updates into stable existing rows rather than replacing the history
- [x] 6.4 Add active-run stop control with server-confirmed state and preserved received output
- [x] 6.5 Add waiting-run response and resume control using the existing resume semantics
- [x] 6.6 Build the native permission request presentation with tool, arguments, risk context, thread, run, and request identity
- [x] 6.7 Implement exactly-once approve and deny actions plus inert expired or superseded request states
- [ ] 6.8 Add keyboard navigation, focus order, visible focus, selection, and screen-reader-equivalent labels supported by GPUIX
- [x] 6.9 Add unit and native-renderer tests for prompt, streaming, stop, resume, approval, denial, and stale-request behavior

## 7. Reliability, Release, and Rollback

- [x] 7.1 Implement deterministic shutdown of Socket.IO, lifecycle subscriptions, in-flight requests, timers, and native windows
- [x] 7.2 Add startup recovery for malformed preferences, unavailable persistence, rejected sessions, unavailable server, and renderer crashes
- [x] 7.3 Add redacting structured diagnostics for bootstrap, transport, realtime, state reconciliation, renderer, and unsupported effects
- [x] 7.4 Build distributable native development and release artifacts for each verified supported host
- [x] 7.5 Verify native failure never mutates or deletes server data needed by the React DOM client
- [x] 7.6 Verify removing or disabling the experimental launch selection immediately restores the unchanged web default

## 8. Functional and Performance Acceptance

- [x] 8.1 Add a product-client benchmark adapter that reuses renderer-neutral workloads without shipping the adapter in production builds
- [x] 8.2 Validate equivalent fixture inventory, ordered identities, final checksums, retained counts, and visible counts where the native API exposes them
- [x] 8.3 Add end-to-end native smoke coverage for login, project/thread selection, long history, prompt, streaming, stop/resume, permissions, reconnect, and logout
- [x] 8.4 Run repeated-navigation and quiescent-memory profiling and investigate retained growth until GPUIX is at or below the 5 percent target
- [x] 8.5 Run a controlled paired release profile against React DOM and record CPU, RSS, memory growth, capability gaps, and renderer-specific diagnostics
- [x] 8.6 Keep frame and input-to-present acceptance inconclusive whenever GPUIX lacks a verified public presentation boundary
- [x] 8.7 Record an evidence-bounded rollout recommendation without promoting a single-machine result to a universal claim

## 9. CI, Documentation, and Final Verification

- [x] 9.1 Add CI contract and state coverage on all hosts plus GPUIX build/native smoke only on verified compatible runners
- [x] 9.2 Document experimental launch, supported hosts, session persistence, fallback, known limitations, artifact locations, and troubleshooting
- [x] 9.3 Run focused platform, state, auth, realtime, renderer, adapter, and end-to-end tests
- [x] 9.4 Run React diagnostics for both renderer packages and classify GPUIX intrinsic-property false positives with source evidence
- [x] 9.5 Run `bun run lint` and resolve every new error introduced by this change
- [x] 9.6 Run `bun run typecheck` and resolve every new error introduced by this change
- [x] 9.7 Run the complete repository test suite and confirm existing browser behavior and performance coverage remain green
- [ ] 9.8 Execute supported-host release smokes and capture any unsupported targets or capabilities in the implementation handoff
