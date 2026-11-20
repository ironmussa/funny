# opencode-provider Specification

## Purpose

Run [opencode](https://opencode.ai) (sst/opencode) as a selectable agent backend in funny over the Agent Client Protocol (ACP), with dynamically discovered models, native session fork/resume, and runner-side authentication. opencode mirrors the Cursor provider (dynamic, user-configured model catalog) and reuses funny's existing ACP machinery (`BaseAgentProcess`, `acp-tool-input`/`acp-image`/`acp-mcp`, out-of-process fork).

## Requirements

### Requirement: opencode selectable as an ACP agent provider

The system SHALL expose `opencode` as a selectable `AgentProvider`, executed by an `OpenCodeACPProcess` that communicates with the `opencode acp` CLI over the Agent Client Protocol (JSON-RPC/stdio) and translates ACP session updates into funny's internal message stream.

#### Scenario: opencode binary present

- **WHEN** the runner has the `opencode` binary resolvable (in PATH or via configured override/npx) and the user starts a thread with `provider = 'opencode'`
- **THEN** the runtime spawns `opencode acp`, completes the ACP `initialize` handshake, opens a session, and streams assistant messages, tool calls, and results into the thread

#### Scenario: opencode binary absent

- **WHEN** the runner cannot resolve the `opencode` binary
- **THEN** provider detection reports opencode as unavailable and the Settings UI does not offer it as a selectable provider

#### Scenario: Multi-turn follow-up on a live session

- **WHEN** an opencode thread has completed a turn and the user sends a follow-up message
- **THEN** the adapter issues the prompt on the same live ACP session via `sendPrompt` without respawning the process

### Requirement: Dynamic model discovery for opencode

The system SHALL discover opencode's available models at runtime rather than from a static registry, exposing them through `GET /api/system/opencode/models` and the client model picker. The static registry SHALL carry only a `default` sentinel.

#### Scenario: Models discovered successfully

- **WHEN** the client requests `/api/system/opencode/models` and opencode is authenticated on the runner
- **THEN** the endpoint returns `{ ok: true, models: [{ modelId, name }], currentModelId }` and the picker lists those models under an opencode group

#### Scenario: opencode not authenticated

- **WHEN** discovery runs and the user has not completed `opencode auth login` on the runner
- **THEN** the endpoint returns `{ ok: false, reason: 'auth_required', message }` and the UI surfaces an actionable login hint instead of an opaque error

#### Scenario: Discovery result is cached

- **WHEN** two model-discovery requests arrive within the cache TTL
- **THEN** the second request is served from cache without spawning a second `opencode` process (unless `refresh=1` is passed)

### Requirement: Runner-side authentication for opencode

The system SHALL rely on opencode's own credential store, configured by the user via `opencode auth login` on the runner. funny SHALL NOT inject opencode provider credentials and SHALL NOT add an opencode entry to the per-user provider key registry.

#### Scenario: User authenticates on the runner

- **WHEN** the user has run `opencode auth login` on the runner host
- **THEN** opencode threads and model discovery operate using those stored credentials, with no funny-managed key

#### Scenario: No funny-managed key surface

- **WHEN** a user opens Settings
- **THEN** no opencode API-key field is shown (opencode is authenticated out-of-band, matching the Cursor model)

### Requirement: Native session fork for opencode

The system SHALL support out-of-process ACP session fork for opencode so opencode threads branch the same way codex, gemini, pi, and cursor threads do, when opencode advertises the fork capability.

#### Scenario: Fork capability advertised

- **WHEN** a fork is requested on an opencode thread and opencode advertised the fork capability at `initialize` (under `sessionCapabilities.fork`)
- **THEN** the runtime forks the session natively and returns the new session id

#### Scenario: Fork capability not advertised

- **WHEN** opencode does not advertise the fork capability
- **THEN** the fork operation reports `capability_not_advertised` so the caller falls back to a non-native branch (consistent with existing ACP providers)
