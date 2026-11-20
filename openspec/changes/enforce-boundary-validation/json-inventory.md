## JSON / Config Boundary Inventory

Inbound JSON/config surfaces found during task 6.1:

### Persisted DB/storage JSON

- Shared repositories:
  - `packages/shared/src/repositories/message-repository.ts`
  - `packages/shared/src/repositories/tool-call-repository.ts`
- Server services:
  - `packages/server/src/services/profile-service.ts`
  - `packages/server/src/services/runner-manager.ts`
  - `packages/server/src/services/project-repository.ts`
  - `packages/server/src/services/thread-event-repository.ts`
- Runtime services:
  - `packages/runtime/src/services/runner-credentials.ts`
  - `packages/runtime/src/services/project-config-service.ts`
  - `packages/runtime/src/services/plugin-service.ts`
  - `packages/runtime/src/services/skills-service.ts`
  - `packages/runtime/src/services/thread-service/*`
  - `packages/runtime/src/services/handlers/agent-completed-queue-handler.ts`
- Memory package:
  - `packages/memory/src/consolidator.ts`
  - `packages/memory/src/types.ts`

Representative migration completed:

- `runner-credentials.json` now uses `parseStoredJson(runnerCredentialsSchema, raw, label)`.
- `user_profiles.provider_keys` and `user_profiles.active_builtin_providers` now use `parseStoredJson`.
- `.funny.json` readers in runtime/core now use `parseStoredJson(funnyProjectConfigSchema, raw, label)`.

### External/API/command JSON

- HTTP/provider responses:
  - GitHub route helpers and route files still cast `await res.json()` results directly.
  - AssemblyAI token endpoints in server/runtime profile/transcription flows still cast decoded payloads directly.
  - Orchestrator HTTP client still parses raw text as generic `T`.
- Command/stdout/LLM JSON:
  - `packages/core/src/git/github.ts`
  - `packages/core/src/containers/container-service.ts`
  - `packages/core/src/agents/llm/*`
  - `packages/runtime/src/services/test-runner.ts`
  - `packages/runtime/src/services/pipeline-manager.ts`
  - `packages/runtime/src/pipelines/yaml-compiler.ts`
- Local sockets/NDJSON:
  - `packages/runtime/src/services/pty-daemon.ts`
  - `packages/runtime/src/services/pty-backend-daemon.ts`
  - `packages/runtime/src/services/pty-backend-node-pty.ts`
  - `packages/runtime/src/services/pty-helper.mjs` (JavaScript helper, outside current TypeScript checker scope)

### YAML/config/env/CLI

- Pipeline YAML is already parsed and validated through `parsePipelineYaml` and `pipelineSchema.safeParse`.
- Provider manifests are already parsed and validated through `parseFunnyProviderFile`.
- `.funny.json` is now validated through `funnyProjectConfigSchema` while preserving unknown fields with `.passthrough()`.
- Tool inputs in the harness are already validated with each tool's `inputSchema.safeParse`.
- Env parsing is mostly scalar booleans/numbers/strings and stays outside this structured JSON phase.
- CLI/API ACP JSON argument parsing remains direct `JSON.parse` debt outside the initial checker scope because that package is not part of the core server/runtime/shared enforcement path yet.

### Enforcement

- `packages/shared/src/json-validation.ts`
  - `parseStoredJson(schema, raw, label)` parses JSON text and validates with Zod.
  - `parseExternalPayload(schema, value, source)` validates already-decoded provider/API payloads with Zod.
- `scripts/fitness/check-json-boundary-validation.ts`
  - Flags new direct `JSON.parse` calls in `server`, `runtime`, `shared`, `core`, `orchestrator`, and `memory` source.
  - Excludes tests and the shared helper implementation.
  - Baseline: `.fitness/json-boundary-validation-baseline.txt`.
