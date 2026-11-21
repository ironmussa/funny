# agent-resources Specification

## Purpose

TBD - created by archiving change agent-resources. Update Purpose after archive.

## Requirements

### Requirement: Agent Resources inventory groups resources by provider

The system SHALL expose an Agent Resources inventory that groups skills, slash commands, MCP servers, plugins, connectors, built-in tools, and template resources by their owning or compatible provider.

#### Scenario: Claude resources appear under Claude

- **WHEN** a project has `.claude/skills`, `.claude/commands`, Claude plugins, or Claude.ai connector tools
- **THEN** Agent Resources lists those resources under the Claude provider group
- **AND** each resource includes its origin and whether it is usable by Claude

#### Scenario: Non-Claude resources appear under their provider

- **WHEN** DeepAgent, Codex, Gemini, Cursor, opencode, pi, or another provider has provider-specific resources
- **THEN** Agent Resources lists those resources under that provider group
- **AND** the resources are not merged into the Claude provider group

### Requirement: Composer suggestions are scoped to the effective provider

The composer SHALL only suggest slash commands and skill-like resources that are usable by the effective provider for the current thread or draft.

#### Scenario: Codex composer hides Claude skills

- **WHEN** the selected provider is Codex and the selected project has Claude skills installed
- **THEN** the slash autocomplete does not suggest those Claude skills

#### Scenario: Claude composer shows Claude skills

- **WHEN** the selected provider is Claude and the selected project has Claude skills or Claude project commands installed
- **THEN** the slash autocomplete suggests those Claude resources using their descriptions when available

#### Scenario: Provider change invalidates suggestions

- **WHEN** the user changes the selected provider or model in the composer
- **THEN** the cached slash suggestions are invalidated
- **AND** the next slash autocomplete request is resolved for the new effective provider and model

### Requirement: Runtime resource injection is scoped to the effective provider

The runtime SHALL inject only MCP servers and tool resources compatible with the effective provider for the run.

#### Scenario: Provider-incompatible MCP server is not injected

- **WHEN** a configured MCP server is not compatible with the effective provider
- **THEN** the runtime does not include that server in the process options for the agent run

#### Scenario: Claude keeps existing MCP behavior

- **WHEN** the effective provider is Claude
- **THEN** enabled Claude-compatible project and user MCP servers are injected as they were before this change

#### Scenario: ACP providers receive only supported MCP transports

- **WHEN** the effective provider is an ACP provider with limited MCP transport capabilities
- **THEN** the runtime passes only MCP servers that are both policy-compatible and transport-compatible with that provider

### Requirement: Resource origin and compatibility are explicit

Every Agent Resource returned by the resolver SHALL include its resource kind, provider ownership or compatibility, origin, and usability state.

#### Scenario: Legacy Claude skill has Claude-only compatibility

- **WHEN** the resolver reads a skill from `.claude/skills` or `{project}/.claude/skills`
- **THEN** the returned resource has origin identifying the Claude skill source
- **AND** the returned resource is usable for Claude and not usable for non-Claude providers

#### Scenario: Hidden resource includes reason

- **WHEN** a resource exists but is not usable for the requested provider or phase
- **THEN** the resolver includes a reason such as `provider_mismatch`, `unsupported_transport`, or `disabled`

### Requirement: Settings inventory and execution filtering are separate phases

The system SHALL distinguish Settings inventory from composer and runtime resource resolution.

#### Scenario: Settings shows incompatible resources for audit

- **WHEN** a resource exists for a provider different from the currently selected thread provider
- **THEN** Agent Resources Settings can display that resource under its owning provider

#### Scenario: Composer and runtime exclude incompatible resources

- **WHEN** a resource is visible in Settings but incompatible with the effective provider
- **THEN** the composer does not suggest it
- **AND** the runtime does not inject it

### Requirement: Auto model routing resolves before resources

When a thread or draft uses an automatic model selection sentinel, the system SHALL resolve the concrete provider and model before resolving Agent Resources.

#### Scenario: Auto resolves to Codex

- **WHEN** automatic model routing resolves a draft or run to Codex
- **THEN** composer suggestions and runtime resources are resolved for Codex
- **AND** Claude-only skills are not suggested or injected

#### Scenario: Fixed provider bypasses auto resolution

- **WHEN** a thread has a fixed provider and model
- **THEN** Agent Resources are resolved directly for that fixed provider and model

### Requirement: Skills and slash commands are distinct kinds with provider-scoped sources

The resolver SHALL model skills and slash commands as separate resource kinds, and SHALL classify each slash command as built-in (provider-shipped) or custom (user-authored). Built-in commands SHALL be sourced only from the provider session; the system SHALL NOT hardcode or filesystem-scan built-in commands. Custom commands SHALL be sourced per provider, where `.claude/commands` (and Claude plugin commands) is the Claude-only mechanism.

#### Scenario: Skills and commands are not conflated

- **WHEN** the resolver returns resources for a project with both `.claude/skills` and `.claude/commands`
- **THEN** skills are returned with kind `skill`
- **AND** project commands are returned with kind `slash-command`

#### Scenario: Built-in commands come from the session, not the filesystem

- **WHEN** resources are resolved for any provider
- **THEN** built-in slash commands are taken from that provider's session-reported command list
- **AND** no built-in command list is hardcoded or read from the filesystem

#### Scenario: Custom commands are Claude-only in v1

- **WHEN** the effective provider is not Claude
- **THEN** the resolver returns no filesystem custom commands for that provider
- **AND** `.claude/commands` entries are not offered to that provider

#### Scenario: Each provider owns its filesystem skills

- **WHEN** the effective provider is Codex and Codex skills exist under `~/.codex/skills` or `{project}/.codex/skills`
- **THEN** the resolver returns those skills as usable for Codex
- **AND** does not return Claude `.claude/skills` for Codex
- **AND** the composer can suggest the Codex skills even before a session starts

#### Scenario: ACP session commands are captured

- **WHEN** an ACP provider emits an available-commands update during a session
- **THEN** the runtime captures those commands and propagates them through the same session-command channel used for Claude
- **AND** the composer can suggest them for that provider

### Requirement: Existing send-boundary slash validation remains authoritative

The system SHALL continue using session-reported slash commands to validate slash command sends when such a command list is available.

#### Scenario: Unknown command is rejected

- **WHEN** a user sends a slash command that is not in the captured session command list
- **THEN** the send boundary rejects the message before it is forwarded to the provider

#### Scenario: Captured command is allowed

- **WHEN** a user sends a slash command that is present in the captured session command list
- **THEN** the send boundary allows the message to reach the provider
