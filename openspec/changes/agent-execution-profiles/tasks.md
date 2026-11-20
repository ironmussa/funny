## 1. Data Model and Validation

- [ ] 1.1 Add shared `AgentExecutionProfile`, Claude profile config, project binding, and resolved profile snapshot types.
- [ ] 1.2 Add zod schemas for profile create/update, project binding update, and profile responses with config redaction where needed.
- [ ] 1.3 Add database schema/migrations for user-owned profiles and `(project_id, user_id) -> profile_id` bindings.
- [ ] 1.4 Add repository methods for profile CRUD, binding CRUD, binding cleanup/fallback, and effective profile resolution.

## 2. Server and Runtime APIs

- [ ] 2.1 Add authenticated routes to list/create/update/delete the current user's profiles.
- [ ] 2.2 Add project route support to read and update the current user's profile binding for a project.
- [ ] 2.3 Enforce ownership checks so users cannot read, mutate, bind, or resolve profiles owned by another user.
- [ ] 2.4 Add response redaction so client-facing payloads never include raw profile env values or sensitive config beyond intended display fields.

## 3. Thread Resolution and Agent Launch

- [ ] 3.1 Resolve the effective project-bound profile in thread creation/start paths before falling back to project provider/model/permission defaults.
- [ ] 3.2 Persist non-sensitive resolved profile metadata on newly created threads.
- [ ] 3.3 Translate Claude profile `configDir` to `env.CLAUDE_CONFIG_DIR` in the runtime agent env passed to the orchestrator.
- [ ] 3.4 Update `SDKClaudeProcess` to merge `this.options.env` into the SDK `env` while preserving existing internal Claude env stripping.
- [ ] 3.5 Ensure thread/composer payload validation does not accept a per-thread profile override.

## 4. Client UI

- [ ] 4.1 Add client API/store hooks for profile CRUD and project profile binding.
- [ ] 4.2 Add Settings UI for creating, editing, deleting, and listing the current user's agent execution profiles.
- [ ] 4.3 Add Project Settings UI for choosing the current user's profile for the current project.
- [ ] 4.4 Keep the new thread composer free of profile selection controls and use the project-bound effective profile.
- [ ] 4.5 Add localization strings for the new Settings and Project Settings surfaces.

## 5. Tests

- [ ] 5.1 Add repository/unit tests for profile CRUD, ownership enforcement, binding resolution, stale binding fallback, and fallback order.
- [ ] 5.2 Add runtime tests proving Claude profile resolution passes `CLAUDE_CONFIG_DIR` to `startAgent`/orchestrator.
- [ ] 5.3 Add core tests proving `SDKClaudeProcess` passes `options.env` to the Claude SDK spawn path.
- [ ] 5.4 Add server route tests for profile CRUD, project binding, and cross-user rejection.
- [ ] 5.5 Add client tests for profile Settings UI, Project Settings profile selector, and absence of a composer profile picker.
- [ ] 5.6 Add an integration-style test for two users in the same project resolving different or absent profile bindings.

## 6. Verification

- [ ] 6.1 Run focused tests for shared/server/runtime/core/client changes.
- [ ] 6.2 Run `bun run lint`.
- [ ] 6.3 Run `bun run typecheck`.
