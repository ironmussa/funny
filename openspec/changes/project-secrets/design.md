# Design

## Context

See proposal.md for the motivation. The pieces this design builds on:

- **Keyring.** `packages/shared/src/lib/crypto.ts` gives AES-256-GCM `encrypt` / `decrypt` / `reencrypt` with a rotatable keyring; the server reaches it through `packages/server/src/lib/crypto.ts`. Provider keys already upgrade to the active key on read (`profile-service.ts:58`).
- **Agent environment.** `buildAgentEnv` (`packages/runtime/src/services/agent-startup/agent-env.ts:90`) builds the variables funny adds for an agent (provider keys, LLM proxy, git identity, assets dir, `$BROWSER`). `applyAgentProfile` (`agent-lifecycle.ts:655`) then lays the user's agent execution profile over it. Both are called once per agent start (`agent-lifecycle.ts:367`).
- **Data channel.** The runner has no database. It asks the server through `data:*` messages over gRPC (`protocol/runner/v2/operations.proto`). Each type needs a rule in `DATA_SCOPE_RULES` (`services/data-scope.ts`); a `refs` rule checks every referenced thread against `canRunnerAccessProject`, and a sandbox runner is confined to its bound thread by `sandboxDataScope`. Handlers in `data-message-handlers.ts` receive `{ runnerId, ownerId, data }`, where `ownerId` is the runner's owner.
- **Sandbox trust.** Whatever a sandbox runner receives is readable by the agent and, through steer sharing, by a sharee. That is why GitHub credentials never go there (`touchesGithubSecret`).
- **Roles.** `Capability` is `view | comment | steer | manage | delete` (`packages/shared/src/auth/roles.ts`). `projectProcedure(capability)` answers 404 without a role and 403 without the capability.
- **Reference.** t3code (`pingdotgg/t3code`, commit `634ee43d`) stores one `0600` file per secret with no encryption and relies on file permissions, which fits a single-user local app. funny is multi-tenant with the database on the server, so only its write-only field (`SettingsSecretValue`), its "fail, never blank" rule and its secret-request card (phase 2) carry over.

## Goals / Non-Goals

**Goals:**

- One table, one server module that decides what a thread's agent receives, one runtime module that applies it.
- A shared secret cannot be used to run code on, or take credentials from, another member's runner.
- No new exception to runner isolation, the steer allow-list or the sandbox GitHub rules.

**Non-Goals:**

- Hiding a secret from the agent or the model. An agent that has a variable can print it.
- Secrets in PTY terminals and project startup commands, a worktree `.env` file, `op://` references, an agent-facing "ask for a secret" tool (phase 2).
- Exposing secrets in the public API v1.
- Moving `project_runner_settings.github_token` or the provider keys into the new table.

## Decisions

### D1. One table, `scope` column, no nullable unique key

`project_secrets`:

| column                                   | notes                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `id`                                     | primary key                                                              |
| `project_id`                             | references `projects.id`, `ON DELETE CASCADE`                            |
| `scope`                                  | `'project'` or `'user'`                                                  |
| `user_id`                                | the owner for `scope = 'user'`; the empty string for `scope = 'project'` |
| `name`                                   | the environment variable name                                            |
| `ciphertext`                             | keyring-encrypted value                                                  |
| `allow_in_sandbox`                       | integer boolean, default 0                                               |
| `updated_by`, `created_at`, `updated_at` |                                                                          |

Unique on `(project_id, scope, user_id, name)`. `user_id` is `''` rather than `NULL` for shared rows because a unique index treats `NULL`s as distinct in both SQLite and Postgres, which would allow duplicate shared names. This matches the `projectId: ''` sentinel funny already uses for scratch threads.

_Alternative: put personal overrides in agent execution profiles_, which already carry an `env` per `(project, user)`. Rejected: a profile applies only when its provider matches the agent being started (`agent-profile.ts`), and a secret must arrive whatever the provider.

_Alternative: two tables._ Rejected: the resolution query, the limits and the audit are the same for both scopes.

### D2. Name rules live in one shared, browser-safe module

`@funny/shared/project-secrets` exports `validateSecretName(name)` and the constants (pattern `^[A-Za-z_][A-Za-z0-9_]*$`, 128 characters, 32 KiB value, 100 per scope). The reserved set:

- exact: `PATH`, `HOME`, `SHELL`, `USER`, `IFS`, `ENV`, `BASH_ENV`, `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `PYTHONSTARTUP`, `GH_TOKEN`, `GITHUB_TOKEN`, `TEAM_SERVER_URL`, `RUNNER_AUTH_SECRET`, `BROWSER`, `SSH_AUTH_SOCK`, `SSH_ASKPASS`, and every `envVar` in `PROVIDER_KEY_REGISTRY`;
- prefixes: `LD_`, `DYLD_`, `BUN_`, `NPM_CONFIG_`, `GIT_`, `GH_`, `ANTHROPIC_`, `CLAUDE_`, `CODEX_`, `GEMINI_`, `FUNNY_`.

The comparison is case-insensitive. The server validates on write (the contract schema calls the same function) **and** filters on delivery, so a name that becomes reserved later is not delivered even if a row exists. The client uses the function for inline form errors.

Why this matters: with shared scope, a member who can write `NODE_OPTIONS` or `LD_PRELOAD` runs code in every other member's runner, and `ANTHROPIC_BASE_URL` redirects their model traffic together with their key.

### D3. Secrets go under funny's own variables

Merge order at agent start, later wins:

1. the runner's inherited environment,
2. project secrets (shared, then the thread owner's personal),
3. `buildAgentEnv` output,
4. the agent execution profile.

A project secret overrides the runner's inherited value of the same name (a project's `DATABASE_URL` should win over a stray one in the runner's shell) but never a variable funny computed. D2 already keeps the dangerous names out; the order is the second layer.

Implemented by a `loadProjectSecretEnv(threadId)` step whose result is spread first inside the function that composes the agent env, so the order is visible in one place.

### D4. One server function decides what a thread receives

`resolveThreadSecrets({ threadId, runnerId, runnerOwnerId })` in `packages/server/src/services/project-secrets.ts` is the only reader of decrypted values:

1. Load the thread. No project (scratch) → empty.
2. `sandboxThreadOfRunner(runnerId)` tells whether the asker is the thread's sandbox runner. If it is not, require `thread.userId === runnerOwnerId`. (Data scope has already checked `canRunnerAccessProject`; this adds the owner check the `refs` rule does not make.)
3. Select the project's `scope = 'project'` rows and the `scope = 'user'` rows of **the thread's owner**. A personal row replaces the shared row of the same name.
4. For a sandbox runner, drop the rows with `allow_in_sandbox = 0`. This runs after step 3, so a personal row with the switch off also hides the shared value of that name (spec: "Personal override decides for its name").
5. Drop names that fail `validateSecretName`.
6. Decrypt. A row that fails to decrypt makes the whole call fail with the row's name; nothing is returned.
7. Audit `secret.delivered` with thread, runner and names.

It returns `Result<{ name, value }[], SecretDeliveryError>` (`neverthrow`, a service boundary).

The thread's owner, not the sender of the message, selects the personal rows. So a steer sharee's follow-up, an automation run and a factory run all get the same secrets as the owner's own message, with no code specific to any of them: they all reach the same agent start on the owner's runner.

### D5. `data:get_project_secrets { threadId }`, rule `refs`, fetched at every start

- New request / response pair in `runner-protocol.ts`, a new operation in `protocol/runner/v2/operations.proto` (regenerate `packages/shared/src/generated/runner-v2`), `threadScoped('data:get_project_secrets')` in `grpc/operations-handler.ts`, the adapter entry in `runtime/services/grpc-operations-adapter.ts`, and the client method next to `data:get_github_app_token` in `remote-project-identity-client.ts`.
- `DATA_SCOPE_RULES['data:get_project_secrets'] = 'refs'`. A normal runner passes only if it may serve the thread's project; a sandbox runner only for its bound thread. It is **not** added to `SANDBOX_ONLY_TYPES` and `touchesGithubSecret` is unchanged.
- The response is `{ secrets: { name, value }[] }` or `{ error, message, secretName? }`.
- The runtime asks once per agent start and keeps the values in memory for that run only. No cache across starts and nothing on disk: a changed or deleted secret applies on the next start, and a revoked member's runner stops receiving values as soon as `canRunnerAccessProject` says no.
- On an error response the agent start fails and the thread shows the message (spec: "A secret cannot be read"). Starting without the secret would let the agent run against a default or another account without anyone noticing.

_Alternative: push the secrets inside the start request the server proxies to the runner._ Rejected: follow-ups, resumes, automations and factory steps all start agents through different requests; the pull at agent start covers every path with one call.

### D6. Redaction in the runtime, at the two places output leaves it

`@funny/shared/project-secrets` exports `createSecretRedactor(secrets)`: it keeps the values of 8 characters or more, sorts them longest first, and replaces each occurrence in a string with `[secret:NAME]`. Multi-line values are matched whole and also line by line for lines of 8 characters or more, since a PEM key is usually printed or logged in pieces.

The runtime builds a redactor per agent run from what D5 returned and applies it in `agent-message-handler.ts` to message content, tool call input and tool output, before the persistence call and before `emitWS`. Both paths take the same already-redacted string, so the stored transcript and the live stream cannot disagree.

It is in the runtime because the persisted message and the browser event leave the runner by different routes; redacting on the server would need the values resolved again per message there.

This is a filter on what funny stores and shows. The provider's CLI runs tools itself and feeds their output to the model before funny sees it, so the model can read a printed value, and an encoded or split value is not matched. The UI says so next to the list.

### D7. tRPC group `projectSecrets`, values never in a response

`packages/api` procedures over `ctx.ports.projectSecrets`, implemented in `packages/server/src/trpc/ports/project-secrets.ts`:

- `list` — `projectProcedure('view')`. Returns `{ id, name, scope, allowInSandbox, updatedBy, updatedAt }[]`: shared rows plus the caller's personal rows.
- `set` — input `{ projectId, scope, name, value?, allowInSandbox }`. `projectProcedure('steer')`; the port then requires `manage` when `scope === 'project'` and answers `failure(403, …)` otherwise. `value` is required when the row does not exist and optional when it does, so the sandbox switch can change without retyping the value. Upsert on the unique key.
- `delete` — input `{ projectId, id }`, same capability rule, and a personal row must be the caller's (404 otherwise).

Schemas in `@funny/shared/contracts/project-secrets.ts`. There is no `get` procedure and the row-to-contract mapper has no `value` field, so a value cannot leak by returning a row. Add `projectSecrets` to the tRPC fitness list; no REST path exists to retire.

### D8. Client: a query, not a collection

`packages/client/src/data/project-secrets/` with `hooks.ts` (`useProjectSecrets(projectId)`) and `actions.ts` (`setProjectSecret`, `deleteProjectSecret`). The list is request-shaped and the writes wait for the server (like profile saves), so it is a query on the shared `QueryClient`, invalidated after each write, with no optimistic step: showing a secret as saved before the server accepted the name would be wrong for a refused reserved name.

UI: `components/settings/ProjectSecretsSettings.tsx` in the project settings, built from shadcn `Input`, `Textarea`, `Button`, `Switch`, `Dialog`, `AlertDialog`, `Badge`. `ShareThreadButton.tsx` gains one sentence at the `steer` level. The field behaviour follows t3code's `SecretInput` and `SecretRequestCard`:

- **Two lists, Shared and Mine.** Each row shows the name, the sandbox switch, who last changed it and when. Shared-list controls are disabled without `manage`. A personal row whose name also exists in the shared list carries an "overrides shared" badge, and the shared row an "overridden by yours" badge, so the member can tell which value their agents get.
- **Add / replace dialog.** The name is editable only when adding: it is the key, so a rename is a delete and an add. The value field is a password-type input with a show / hide button. A "multi-line" switch replaces it with a textarea for values such as PEM keys; the textarea is not masked, and the dialog says so.
- **A stored value never comes back.** When replacing, the value field is empty with the placeholder "Stored, type a new value to replace", and saving it empty keeps the stored value (`value` is optional in `set`, D7).
- **Keep the value out of the browser's password store.** The value field sets `autoComplete="off"` and the password-manager ignore attributes (`data-1p-ignore`, `data-lpignore`, `data-bwignore`), and the dialog clears the field before it closes so the browser does not offer to save a login. A refused save puts the typed value back.
- **Delete confirmation says what changes.** "Agents started from now on will not get `NAME`"; for a personal secret that overrides a shared one, "your agents will get the shared value again".
- **Two notices** next to the lists: who can read a shared secret, and that redaction is best effort.

### D9. Cleanup and key rotation

- Project deletion: the foreign key cascade.
- Member removal (`project-manager.removeMember`): delete that member's `scope = 'user'` rows for the project in the same call. They would never be delivered again (the member's runner fails `canRunnerAccessProject`), but they should not outlive the membership.
- Key rotation: `resolveThreadSecrets` re-encrypts a row with `reencrypt` when it was read with a non-active key, the same lazy upgrade `profile-service.ts` does.

## Risks / Trade-offs

- **A shared secret is readable by every member with `steer`, and by a steer sharee of any thread in the project** → stated in the settings UI and the share dialog; `secret.delivered` records each delivery. Teams that need a value only one person holds use a personal secret.
- **A sandbox secret is readable by the sandbox agent, including under a prompt injection** → off by default, switched on per secret.
- **The reserved list is a deny-list and can miss a variable** → the merge order (D3) keeps funny's own variables safe regardless; the list is one constant with tests, and delivery re-checks it. A project member with push access can already change the code the agent runs, so the list closes the cheap path, not every path.
- **Redaction misses encoded or split values and can blank ordinary text equal to a secret** → 8-character minimum, documented as best effort, not relied on for any access decision.
- **A runner older than this change never asks for secrets** → its agents start without them, as today. The settings UI cannot detect this in phase 1; the docs mention updating the runner.
- **Old transcripts are not re-redacted when a secret is added later** → accepted; redaction applies from the run that delivered the value.
- **A decrypt failure blocks every agent start in the project** → the error names the secret so the user can re-save or delete it.

## Migration Plan

1. Server deploy: migration adds `project_secrets` (empty); the new data type and tRPC group are additive.
2. Runner deploy: the runner starts asking at agent start. With no rows the answer is empty and nothing changes.
3. Rollback: revert both deploys. The table can stay; nothing else reads it.

Server before runner. A new runner against an old server would get "no scope rule" for the request; the runtime treats an unknown-type refusal as "no secrets" only for that specific error, so a mixed deployment still starts agents.

## Open Questions

- Whether `secret.delivered` should be sampled or aggregated if it proves noisy (one record per agent start in projects with secrets). It does not change the design; decide after seeing real volume.
