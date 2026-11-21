## 1. Shared Types and Resolver Contract

- [x] 1.1 Add shared Agent Resource types for resource kind, origin, compatibility, phase, usability state, and hidden reason
- [x] 1.2 Define request/response DTOs for resolving resources by `projectPath`, `provider`, `model`, optional `threadId`, and phase
- [x] 1.3 Add provider compatibility helpers for known providers with Claude, DeepAgent, ACP, and built-in resource defaults
- [x] 1.4 Add tests for compatibility defaults: Claude skills are Claude-only, DeepAgent skills are DeepAgent-only, MCP defaults are capability-filtered

## 2. Runtime Resource Resolver

- [x] 2.1 Create an Agent Resources resolver service that composes existing skills, plugin, command, MCP, template, and built-in tool sources
- [x] 2.2 Move current Claude skill/command/plugin listing behind resolver source adapters without changing Claude output
- [x] 2.3 Add MCP resource normalization that preserves origin, disabled state, transport, auth/status, and compatibility metadata
- [x] 2.4 Add phase filtering for `settings`, `composer`, and `runtime`
- [x] 2.5 Add hidden/unsupported reason reporting for provider mismatch, unsupported transport, disabled resources, and missing auth

## 3. API Routes

- [x] 3.1 Add provider-aware Agent Resources list endpoint
- [x] 3.2 Keep existing `/skills` response compatible while routing its implementation through the resolver for Claude/default callers
- [x] 3.3 Add query validation for provider, model, project path, thread id, and phase
- [x] 3.4 Add route tests covering Claude inventory, Codex hiding Claude skills, and Settings inventory showing provider groups

## 4. Composer Integration

- [x] 4.1 Update prompt-input state to load composer resources by selected project, provider, and model
- [x] 4.2 Invalidate slash suggestion cache when project, provider, or model changes
- [x] 4.3 Merge provider/session-reported slash commands with resolver resources without suggesting incompatible resources
- [x] 4.4 Update AskQuestionCard and ExitPlanModeCard skill loaders to use provider-scoped resources where provider context is available
- [x] 4.5 Add client tests for provider switching and Claude skill visibility rules

## 5. Agent Resources Settings UI

- [x] 5.1 Add an Agent Resources settings section that groups resources by provider
- [x] 5.2 Move or link existing Skills and MCP settings views into the Agent Resources experience
- [x] 5.3 Show resource origin, compatibility/usability state, disabled status, and management action where applicable
- [x] 5.4 Preserve existing install/remove flows for Claude skills and MCP servers
- [x] 5.5 Add UI tests for provider groups and incompatible resources appearing only in Settings inventory

## 6. Runtime Injection

- [x] 6.1 Update `loadProjectMcpServers` to accept effective provider/model and call the resolver for `phase = 'runtime'`
- [x] 6.2 Update `agent-lifecycle` to resolve resources after concrete provider/model selection and before process construction
- [x] 6.3 Ensure Claude receives the same enabled MCP servers as before when provider is Claude
- [x] 6.4 Ensure non-compatible MCP servers are excluded before ACP/Claude/DeepAgent process options are built
- [x] 6.5 Keep ACP transport filtering as a second line of defense and add tests for policy-plus-capability filtering

## 7. Auto Model Routing Compatibility

- [x] 7.1 Identify the effective provider/model resolution point for `model = auto`
- [x] 7.2 Ensure Agent Resources resolution runs after `auto` has resolved to a concrete provider/model
- [x] 7.3 Add regression coverage for auto resolving to Codex and excluding Claude-only resources

## 8. Slash Command Model (built-in vs custom + ACP capture)

- [x] 8.1 In the resolver, return `skill` and `slash-command` as distinct kinds — stop emitting one merged `Skill[]` for `.claude/skills` + `.claude/commands` + plugin commands
- [x] 8.2 Classify each command as built-in (session-sourced, all providers) or custom (per-provider); set `customCommands` source from the provider descriptor (Claude = `.claude/commands`; others = `none` in v1)
- [x] 8.3 Capture ACP `available_commands_update` in `generic-acp.ts:1066` (currently ignored) instead of dropping it
- [x] 8.4 Propagate captured ACP commands via `commands_changed` so Claude (`sdk-claude.ts:704`) and ACP share one session-command channel
- [x] 8.5 Tests: skills and commands not conflated; built-ins session-only (never hardcoded/filesystem); `.claude/commands` not offered to non-Claude; ACP session commands surface in the composer

## 9. Verification

- [x] 9.1 Runtime tests cover resolver source adapters, phase filtering, and MCP injection filtering
- [x] 9.2 Client tests cover composer cache invalidation and Settings provider grouping
- [x] 9.3 Existing Claude skills/MCP tests remain green
- [x] 9.4 Run relevant package tests for runtime/client/shared
- [x] 9.5 Run typecheck/build for affected packages
