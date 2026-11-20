## Why

Users need to keep personal, work, and client agent accounts separate while using the same funny project workflow. Today a project can default a provider/model/permission mode, but it cannot say "for this user and this project, run Claude with my work account" without relying on whatever Claude Code account the runner is currently authenticated as.

## What Changes

- Add user-owned **agent execution profiles** that name a provider account/configuration such as `Claude Personal`, `Claude Work`, or `Claude Client A`.
- Add a per-user, per-project profile binding so each user can choose which of their profiles a project uses by default.
- Resolve the profile only when creating or starting project threads; threads inherit the project's effective profile and do not expose a profile picker in the thread/composer UI.
- For Claude Code profiles, isolate account state through `CLAUDE_CONFIG_DIR` and pass the profile env through the Claude SDK runner.
- Keep existing project defaults (`default_provider`, `default_model`, `default_permission_mode`) as fallback behavior when no profile binding exists.
- Store enough resolved profile metadata on new threads to make executions auditable without exposing secrets or full sensitive paths.

## Capabilities

### New Capabilities

- `agent-execution-profiles`: User-owned agent execution profiles can be assigned per project, resolved for new thread execution, and translated into runner environment such as Claude's `CLAUDE_CONFIG_DIR`.

### Modified Capabilities

<!-- None — existing project defaults and thread creation behavior remain valid fallbacks. -->

## Impact

- **Shared types and validation** — add profile and project-binding types/schemas; keep provider/model primitives unchanged.
- **Persistence** — add tables or repository storage for user-owned profiles and `(projectId, userId) -> profileId` bindings; consider a thread snapshot field for resolved profile identity.
- **Runtime / runner** — resolve the effective profile before starting agents; merge profile env into process options; update `SDKClaudeProcess` so `this.options.env` is included in its SDK `env`.
- **Client UI** — add Settings UI for managing profiles and Project Settings UI for choosing the profile for the current project/user. Do not add a profile selector to the thread composer.
- **Security / privacy** — profile ownership must be enforced server-side; bindings cannot reference another user's profile; secrets and full config paths should not be broadcast in thread events.
- **Tests** — add unit tests for profile resolution, ownership validation, Claude env propagation, and UI tests for profile management/project assignment. Add integration coverage for creating a thread from a project-bound profile.
