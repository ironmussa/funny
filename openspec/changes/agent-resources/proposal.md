## Why

funny now runs multiple agent providers, but its resource model still exposes Claude-specific concepts globally: `.claude` skills, Claude slash commands, plugins, and project MCP servers can appear or be injected even when the selected provider is Codex, Gemini, opencode, or another non-Claude agent. This creates confusing UI and a real runtime ambiguity: the user cannot tell which resources are usable by the effective provider.

## What Changes

- Introduce **Agent Resources** as the product and API concept for provider-scoped resources an agent can discover, suggest, or execute.
- Replace the current provider-agnostic Skills view with an Agent Resources settings experience grouped by provider.
- Resolve composer slash suggestions from the effective provider instead of only from the selected project.
- Resolve runtime MCP/tool injection from the effective provider and resource policy instead of passing the same project/user MCP set to every process.
- Preserve current Claude behavior when the effective provider is Claude.
- Keep non-compatible resources visible in Settings under their owning provider, but do not suggest them in the composer or inject them into non-compatible providers.
- Treat `model = auto` as a two-step flow: resolve the concrete provider/model first, then resolve agent resources for that effective provider.

## Capabilities

### New Capabilities

- `agent-resources`: Provider-scoped discovery, display, autocomplete, and runtime injection of skills, slash commands, MCP servers, plugins, connectors, built-in tools, and template resources.

### Modified Capabilities

None.

## Impact

- **Runtime**: `packages/runtime/src/services/skills-service.ts`, `routes/skills.ts`, `services/mcp-service.ts`, `services/agent-startup/load-mcp-servers.ts`, and `services/agent-lifecycle.ts` will need provider-aware resource resolution.
- **Core agents**: ACP and Claude process adapters continue consuming tool/MCP inputs, but runtime will pass only resources applicable to the effective provider.
- **Client**: Settings navigation and panels will introduce Agent Resources; composer slash autocomplete will cache by project and provider rather than project only.
- **Shared types/API**: New resource response types are needed to describe provider, resource kind, origin, compatibility, visibility, and hidden/unsupported reasons.
- **OpenSpec adjacency**: The design should stay compatible with the active `provider-manifests` change so provider resource metadata can later move into manifests, but this change should not depend on completing that refactor.
