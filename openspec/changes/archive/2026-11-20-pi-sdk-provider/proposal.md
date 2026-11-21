## Why

Pi now exposes a first-party Node SDK that provides typed sessions, streaming events, steering, follow-up prompts, model registry access, and runtime session operations. funny currently reaches Pi through the ACP shim (`pi-acp`), which adds an extra subprocess/protocol layer and provider-specific translation quirks that the native SDK can avoid.

## What Changes

- Replace the Pi ACP backend with a native SDK-backed provider implementation using `@earendil-works/pi-coding-agent`.
- Keep the public provider id as `pi`, preserving existing thread payloads, model picker behavior, and UI labels.
- Route Pi prompts, follow-ups, steering, abort, model selection, and thinking level through `AgentSession` / `AgentSessionRuntime` instead of ACP JSON-RPC.
- Replace Pi model discovery with `ModelRegistry.getAvailable()` from the Pi SDK.
- Update Pi fork/resume handling to use Pi SDK runtime APIs where available; fall back to context recovery if a native fork is not available.
- Remove Pi-specific ACP process registration while leaving other ACP providers on `GenericACPProcess`.

## Capabilities

### New Capabilities

- `pi-sdk-provider`: Pi provider runs through the first-party Pi SDK while preserving funny's provider contract.

### Modified Capabilities

None.

## Impact

- Adds dependency on `@earendil-works/pi-coding-agent`.
- Touches `packages/core/src/agents` for the new process adapter and model discovery.
- Touches shared provider manifests/model registry to remove Pi from ACP manifest assumptions in the active implementation.
- Touches runtime fork/model-discovery paths where Pi currently uses ACP.
- Updates tests covering Pi process translation, model discovery, process factory registration, and fork behavior.
