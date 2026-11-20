## Context

funny already stores project defaults for provider, model, and permission mode. Those defaults choose _what_ agent to run, but not _which user account/configuration_ the runner should use. Claude Code supports multiple accounts by running with different `CLAUDE_CONFIG_DIR` values; the Claude Agent SDK accepts an `env` object for the spawned Claude Code process. In the current codebase, ACP and DeepAgent processes merge `options.env`, while `SDKClaudeProcess` builds its SDK env from `process.env` and needs to merge `this.options.env` before profile-based Claude execution can work.

The product requirement is intentionally project-scoped: users configure profiles once, assign one profile to each project, and threads inherit that project assignment. The thread/composer UI does not get a profile selector.

## Goals / Non-Goals

**Goals:**

- Let each user define personal/work/client agent profiles without sharing those identities with other users.
- Let each user bind one of their profiles to a project as that user's project default.
- Make Claude profiles isolate Claude Code account/config state through `CLAUDE_CONFIG_DIR`.
- Keep existing provider/model/permission project defaults as fallback behavior.
- Keep thread creation simple: no thread-level profile picker, but new threads record the resolved profile identity for audit/debugging.
- Cover backend, runtime, UI, and tests in the implementation plan.

**Non-Goals:**

- No per-prompt or per-thread profile selection UI.
- No global project profile shared by every collaborator.
- No secret/token storage in funny for Claude Code v1; Claude credentials remain in Claude's config directory.
- No arbitrary environment-variable editor in v1.
- No automatic login flow for Claude profiles beyond surfacing that a profile's config directory needs authentication.

## Decisions

### D1 — Profiles are user-owned and runner-aware

An `AgentExecutionProfile` belongs to a `userId` and optionally records the runner/device it is usable on. The profile stores display/config data only:

```ts
type AgentExecutionProfile = {
  id: string;
  userId: string;
  runnerId?: string | null;
  name: string;
  provider: AgentProvider;
  defaultModel?: string | null;
  defaultPermissionMode?: PermissionMode | null;
  config: ClaudeExecutionProfileConfig;
  createdAt: string;
  updatedAt: string;
};

type ClaudeExecutionProfileConfig = {
  kind: 'claude-code';
  configDir: string;
};
```

Rationale: credentials live on the runner filesystem for Claude Code, so a profile path that works on one runner may not exist on another. User ownership prevents collaborators from accidentally or intentionally using someone else's account.

Alternative considered: make profiles global to the project. Rejected because a shared project would then point every collaborator at one person's account. Alternative considered: duplicate providers such as `claude-work` and `claude-personal`. Rejected because provider identity, account identity, and model selection would become tangled across routing, model pickers, and validation.

### D2 — Project profile binding is per `(projectId, userId)`

A new binding maps the current user to their chosen profile for a project:

```ts
type ProjectAgentProfileBinding = {
  projectId: string;
  userId: string;
  profileId: string;
  createdAt: string;
  updatedAt: string;
};
```

The effective thread defaults resolve in this order:

```text
project profile binding for current user
  > project default provider/model/permission mode
  > app defaults
```

If a profile is bound, it supplies provider plus optional default model/permission mode. Missing model or permission mode fields fall back to the existing project defaults so profiles can be account-only if desired.

### D3 — Threads inherit the resolved project profile, but do not choose profiles

Thread creation resolves the effective profile from the project/user binding. The request payload should not accept a profile id from the thread composer. New threads should store an audit snapshot such as:

```ts
agentProfileId?: string | null;
agentProfileName?: string | null;
agentProfileProvider?: string | null;
```

The snapshot is informational and used for debugging/history. Changing a project binding affects new executions only; existing threads keep their resolved provider/model/permission fields and snapshot.

### D4 — Claude profile config translates to whitelisted env

For `provider: 'claude'`, the profile's `config.configDir` translates to:

```ts
env: {
  CLAUDE_CONFIG_DIR: config.configDir;
}
```

The runtime merges this env into the existing `agentEnv` before calling the orchestrator. `SDKClaudeProcess` must merge `this.options.env` into `sdkEnv`, and its spawn wrapper must keep stripping internal SDK variables (`CLAUDECODE`, `CLAUDE_CODE_ENTRY_POINT`) as it does today.

Rationale: `CLAUDE_CONFIG_DIR` is the official Claude Code separation mechanism, and keeping the UI to a provider-specific config avoids exposing arbitrary env injection as a product feature.

### D5 — UI is split between global profile management and project assignment

Settings gains an `Agent Profiles` section where the current user can create, edit, and delete profiles. Project Settings gains a single selector for the current user's profile for that project. The thread composer keeps its current provider/model/permission controls as applicable, but does not expose a profile selector.

Project assignment UI must show only the current user's profiles. It can display the effective provider/model summary, e.g. `Claude Work · Claude · Opus`, but it must not expose another user's profile or full sensitive config path in shared project surfaces.

### D6 — Tests cover resolution, ownership, runtime env, and UI

The change needs unit tests for:

- Profile validation and ownership checks.
- Binding resolution and fallback order.
- Rejection of bindings to another user's profile.
- `SDKClaudeProcess` env propagation.

Integration tests should cover:

- Creating a Claude profile, binding it to a project, and starting a new thread that receives `CLAUDE_CONFIG_DIR`.
- A second user in the same project not inheriting the first user's binding.
- Deleted/missing profile bindings falling back safely to project defaults.

Client tests should cover:

- Profile CRUD form behavior.
- Project Settings profile selector loading only current-user profiles.
- New thread creation using the project-bound effective profile without a thread-level profile picker.

## Risks / Trade-offs

- **Runner-local paths can be invalid or unavailable** -> Validate paths syntactically, show a "needs setup/login" state, and make runtime failure clear without leaking secrets. Do not try to validate every remote runner path from the client.
- **Profile deletion can leave stale bindings** -> Use repository-level cleanup where possible and fallback resolution when stale data is encountered.
- **Changing a profile can affect future project runs unexpectedly** -> Show affected project bindings in profile detail or warn when editing provider/configDir. Existing threads keep snapshots.
- **Env propagation could leak sensitive config in logs/events** -> Redact profile config values from logs and websocket payloads; expose only profile id/name/provider to the UI.
- **Multiple runners for one user complicate availability** -> Record runner affinity where available and mark profiles unavailable when the active runner cannot use them.

## Migration Plan

Additive migration:

1. Add profile and binding storage.
2. Add repositories/routes and server-side ownership checks.
3. Add runtime resolution and Claude env propagation.
4. Add Settings and Project Settings UI.
5. Backfill nothing; existing projects continue using provider/model/permission defaults until the user creates and binds profiles.

Rollback: hide profile UI and ignore bindings during thread resolution. Existing project defaults and threads continue to work because provider/model/permission fields remain the execution source of truth.

## Open Questions

- Should v1 create managed config directories automatically under funny's data directory, or require the user to choose/provide the path? Leaning managed-by-default with an advanced custom path.
- Should profile names be unique per user/provider, or only per user? Leaning unique per user for simpler selectors.
- Should profile availability be checked lazily at run time only, or also surfaced in Settings through a runner health probe?
