## 1. Dependency and Registration

- [x] 1.1 Add `@earendil-works/pi-coding-agent` as a workspace dependency where the Pi adapter compiles.
- [x] 1.2 Create `PiSDKProcess` and register provider `pi` to use it instead of `PiACPProcess`.
- [x] 1.3 Remove Pi from ACP built-in provider registration while preserving provider id `pi` in shared model/provider metadata.

## 2. SDK Adapter

- [x] 2.1 Initialize Pi SDK auth, model registry, settings/session manager, and agent session for the thread cwd.
- [x] 2.2 Translate Pi SDK message, thinking, tool execution, lifecycle, and completion events into `CLIMessage` events.
- [x] 2.3 Implement live `sendPrompt`, `steerPrompt`, and `kill` behavior through Pi SDK session APIs.
- [x] 2.4 Apply model and effort/thinking-level selections through Pi SDK APIs.

## 3. Model Discovery and Session Operations

- [x] 3.1 Replace Pi model discovery with Pi SDK `ModelRegistry.getAvailable()` while preserving the existing response shape.
- [x] 3.2 Update Pi fork handling to prefer native SDK runtime APIs and fall back to no native session id when unavailable.
- [x] 3.3 Review cold-path/session recovery rules so Pi SDK is not treated as an ACP replay-risk provider.

## 4. Tests and Cleanup

- [x] 4.1 Replace Pi ACP process tests with SDK adapter tests using a mocked Pi SDK.
- [x] 4.2 Update process factory, model discovery, and fork tests for the SDK-backed Pi provider.
- [x] 4.3 Remove obsolete Pi ACP-only imports or comments that no longer describe runtime behavior.
- [x] 4.4 Run focused tests, `bun run lint`, and `bun run typecheck`.
