## Context

funny's current extension/resource surfaces grew out of the Claude path. `skills-service.ts` reads `~/.agents/.skill-lock.json`, `~/.claude/skills`, `~/.claude/plugins`, and `{project}/.claude/{skills,commands}`; the `/skills` API accepts only `projectPath`; the composer caches that response by selected project. MCP management is similarly Claude-shaped: `mcp-service.ts` shells out to `claude mcp list`, merges `~/.claude.json` and `.mcp.json`, and `agent-lifecycle.ts` passes the resulting enabled servers to whichever provider is about to run.

That was acceptable when Claude was the only meaningful provider. It is now misleading because Codex, Gemini, pi, Cursor, opencode, DeepAgent, and future provider extensions have different resource models. Some resources are provider-local (Claude skills), some are session-reported (ACP slash commands), some are shareable but capability-gated (MCP), and some are template-bound (DeepAgent custom skills).

The user-facing product concept should be **Agent Resources**: all resources an agent can discover, show, suggest, or execute, scoped by provider and then by project/thread as needed.

## Goals / Non-Goals

**Goals:**

- Introduce a provider-aware Agent Resources resolver that is the shared source for Settings, composer autocomplete, and runtime injection.
- Make Settings show resources grouped by provider, including incompatible resources under their owning provider for transparency.
- Make the composer suggest only resources usable by the active/effective provider.
- Make runtime inject only resources allowed for the effective provider.
- Preserve existing Claude behavior when `provider === 'claude'`.
- Keep the design compatible with the active `provider-manifests` proposal without depending on it.

**Non-Goals:**

- No rewrite of every provider adapter.
- No full replacement of `.claude` storage formats.
- No arbitrary provider-specific plugin execution model.
- No automatic conversion of Claude skills into Codex/Gemini/opencode resources.
- No change to MCP server install/auth flows beyond provider-aware visibility and runtime filtering.

## Decisions

### Decision 1: Add a resolver layer, not provider checks scattered through UI/runtime

Introduce a runtime service with a contract equivalent to:

```ts
resolveAgentResources({
  projectPath,
  provider,
  model,
  threadId,
  phase: 'settings' | 'composer' | 'runtime',
});
```

It returns provider-scoped resources, compatibility metadata, and hidden/unsupported reasons. Settings, composer, and agent startup call the same resolver with different phases.

- **Why:** Without a central resolver, the bug reappears as ad hoc `provider === 'claude'` branches in the editor, settings panels, and lifecycle code.
- **Alternative considered:** Patch `/skills` only. Rejected because MCP runtime injection would remain ambiguous and the product would still speak in Claude-specific terms.

### Decision 2: Settings is inventory; composer/runtime are capability-filtered

Agent Resources Settings shows resources grouped by provider. A Claude-only skill can remain visible under Claude even while the current thread uses Codex. The composer and runtime, however, must show/inject only resources compatible with the current effective provider.

```txt
Settings inventory:
  Claude
    skill-creator
    claude.ai connector tools

Composer/runtime for Codex:
  skill-creator hidden: provider_mismatch
```

- **Why:** Users need to understand what is installed without being invited to use resources the selected agent cannot execute.
- **Alternative considered:** Hide incompatible resources everywhere. Rejected because it makes Settings feel inconsistent and makes installed resources hard to audit.

### Decision 3: Provider is the primary scoping axis; model is mostly a cache key

The first version scopes resources primarily by provider. `model` is still included in resolver inputs and client cache keys because `auto` must resolve to a concrete provider/model first, and future providers may expose model-specific capabilities. The v1 rules should avoid model-specific resource behavior unless a provider explicitly requires it.

- **Why:** The observed bug is provider leakage, not a difference between two models within the same provider.
- **Alternative considered:** Scope every resource by `provider + model` from day one. Rejected as unnecessary complexity and likely to produce stale policy metadata.

### Decision 4: Split resource origin from resource compatibility

Resource records should carry both:

- `origin`: where it came from (`claude-project`, `claude-global`, `claude-plugin`, `codex-global`, `codex-project`, `mcp-project`, `mcp-user`, `deepagent-template`, `provider-session`, `builtin`)
- `compatibleProviders`: explicit provider allow-list or `all`

For legacy resources with no explicit compatibility:

- `.claude/skills`, `.claude/commands`, and Claude plugins default to `compatibleProviders = ['claude']`
- **Codex skills** (`~/.codex/skills`, incl. the `.system/` built-in set, and `{project}/.codex/skills`) default to `['codex']`. Codex uses the same `<skill>/SKILL.md` layout as Claude but nests built-ins one level deeper under `.system/`, so the scanner walks a bounded depth rather than a single level. **Skills are NOT Claude-only** — each provider owns its skill directory; the resolver scans per provider via the descriptor.
- DeepAgent skills/templates default to `['deepagent']`
- MCP servers default to `all` only after capability filtering, but can be narrowed by future policy metadata
- `funny` built-in MCP tools remain runtime-injected for supported providers

- **Why:** Source answers "where do I manage this?" Compatibility answers "can this provider use it?" They are related but not the same.
- **Alternative considered:** Infer compatibility only from path names. Rejected because project MCP and future provider resources need explicit policy.

### Decision 5: Runtime MCP filtering happens before process construction

`loadProjectMcpServers` should accept the effective provider and return only compatible MCP entries. ACP adapter capability filters remain as a second line of defense, but the lifecycle should not pass every configured server to every provider.

- **Why:** Filtering late prevents unsupported transport use, but it does not express resource policy and still makes process snapshots/provider reuse depend on irrelevant MCP entries.
- **Alternative considered:** Rely on ACP `filterMcpByCapability`. Rejected because Claude and DeepAgent paths do not share that exact filter, and capability is not policy.

### Decision 6: Slash commands are modeled on two orthogonal axes, with session as the source of truth for built-ins

`skills` and `slash commands` are distinct resource kinds and must not be conflated. Today `skills-service.ts` returns both `.claude/skills` (model-invoked) and `.claude/commands` + plugin commands (user-invoked `/foo`) as one undifferentiated `Skill[]`. The resolver SHALL separate them by `kind` and classify each command on two orthogonal axes:

```
                        WHO AUTHORED IT?
                  built-in (provider)      custom (user)
                ┌──────────────────────┬──────────────────────┐
   WHERE        │  Claude: /clear,      │  Claude:             │
   FROM?        │  /compact, /help      │  .claude/commands/   │
   session      │  Codex: its built-ins │  *.md → /opsx:apply  │
                │  → ALWAYS via the     │  (each provider has  │
                │    provider session   │   its own location;  │
                │                       │   .claude is Claude- │
                │                       │   only)              │
                ├──────────────────────┼──────────────────────┤
   filesystem   │      (none — built-   │  Claude: funny scans │
                │   ins are never       │  .claude/commands    │
                │   filesystem-scanned) │  on disk today       │
                └──────────────────────┴──────────────────────┘
```

Rules:

- **Built-in commands are always session-sourced, per provider.** funny SHALL NOT hardcode a built-in command list nor scan the filesystem for them. Claude reports them via the SDK init `slash_commands` (`sdk-claude.ts:704`); ACP providers report them via `available_commands_update`. The provider session is the single source of truth for built-ins — this structurally prevents showing Codex a Claude `/compact`.
- **Custom commands are per-provider, and `.claude/commands` is the Claude mechanism — not universal.** The shared descriptor SHALL declare, per provider, the source of each command tier: `builtinCommands: 'session'` (all providers) and `customCommands: <path> | 'session' | 'none'`.
- **v1 scope:** `customCommands` is a filesystem path only for Claude (`.claude/commands`, plus Claude plugin commands). All other providers get `customCommands: 'none'` for now — a declared extension point, not a built feature. Authoring custom commands for Codex/Gemini/etc. is explicitly out of scope.
- **New work this exposes:** `generic-acp.ts:1066` currently ignores `available_commands_update`. To give non-Claude providers any commands at all in the composer, the runtime SHALL begin capturing that update and propagating it through the same channel Claude's `slash_commands` uses (`AgentMessage.slashCommands`, `types.ts:22`), so both Claude and ACP feed session commands uniformly.
- **Send-boundary validation stays authoritative.** SDK/ACP-reported commands remain the strongest truth for an active thread; send-boundary validation MUST keep rejecting unknown slash commands when a command list was captured.

- **Why:** Some providers discover commands dynamically after session start; a static inventory cannot predict them, and built-ins differ per provider. Separating "who authored" from "where it lives" lets one descriptor drive both display origin and the authoring location without special-casing each call site.
- **Alternative considered:** Keep one merged `Skill[]` and filter by path prefix. Rejected — it cannot represent session-only commands (ACP) and re-introduces Claude-shaped assumptions. Also considered removing session command validation; rejected because it protects users from sending unsupported slash commands as plain text.

### Decision 7: Keep provider-manifest integration as a follow-up seam

The resolver should be built so provider defaults can later come from manifests:

```ts
// Claude
resources: {
  skills:          ['claude-global', 'claude-project', 'claude-plugin'],
  builtinCommands: 'session',
  customCommands:  'claude-commands',            // .claude/commands
  mcp: { supported: true, transports: ['stdio', 'http', 'sse'] },
}
// Codex — has its OWN filesystem skills, commands still session-only
resources: {
  skills:          ['codex-global', 'codex-project'],  // ~/.codex/skills (+ .system), {project}/.codex/skills
  builtinCommands: 'session',
  customCommands:  'none',                        // v1: commands come from the session
  mcp: { supported: true, transports: ['stdio', 'http', 'sse'] },
}
```

For this change, hardcode the known providers in the resolver to keep scope practical. Do not block on the `provider-manifests` refactor.

## Risks / Trade-offs

- **Settings grows more complex** -> Start with a provider-grouped inventory using existing cards, then refine visual density later.
- **MCP compatibility policy is underspecified for legacy config** -> Default project/user MCP to broad compatibility after transport support, but add metadata hooks so future UI can narrow by provider.
- **`auto` routing order can be wrong** -> Require resource resolution after effective provider/model selection; fixed-model threads bypass routing as today.
- **Existing Claude users could lose resources** -> Regression tests must assert Claude sees the same `.claude` skills, commands, plugins, and MCP entries it sees today.
- **Provider manifests may duplicate this metadata later** -> The resolver owns the API contract now; manifests can become an input to it later without changing UI/runtime callers.

## Migration Plan

1. Add shared Agent Resource types and a runtime resolver while keeping existing `/skills` and `/mcp` endpoints working.
2. Add provider-aware endpoints for Agent Resources and adapt Settings to use them.
3. Begin capturing ACP `available_commands_update` in `generic-acp.ts` and propagate it via `AgentMessage.slashCommands`, so non-Claude providers expose session commands through the same channel as Claude.
4. Update composer autocomplete to request resources for the active provider and cache by project/provider/model, separating `skill` from `slash-command` kinds.
5. Update runtime MCP loading to call the resolver for `phase = 'runtime'`.
6. Keep the old Skills/MCP Settings routes as compatibility entry points or redirect them into Agent Resources.
7. After parity tests pass, remove direct provider-agnostic skill loading from composer paths.

Rollback is straightforward: leave the old `/skills` and MCP paths intact until Agent Resources is proven, then switch UI/runtime callers back if needed.

## Open Questions

- Should MCP provider compatibility be editable in the first UI, or should v1 only show inferred compatibility and defer editing?
- Should the Settings navigation keep "MCP Server" as a shortcut into Agent Resources, or remove the separate item immediately?
- How should resources from future external provider extensions expose install/manage actions before provider manifests are complete?
