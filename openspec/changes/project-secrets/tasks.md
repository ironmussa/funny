# Tasks

## 1. Shared rules and contracts

- [x] 1.1 Add `packages/shared/src/project-secrets.ts` (browser-safe subpath export `@funny/shared/project-secrets`) with the name pattern, limits, reserved names and prefixes (D2) and `validateSecretName`; verify with unit tests covering each reserved exact name, each prefix, case-insensitivity, the `PROVIDER_KEY_REGISTRY` variables, invalid shapes and an accepted name
- [x] 1.2 Add `createSecretRedactor` to the same module (D6); verify with unit tests for the 8-character minimum, longest-first replacement when one value contains another, multi-line values matched whole and by line, and an empty secret list returning the input unchanged
- [x] 1.3 Add `packages/shared/src/contracts/project-secrets.ts` (list / set / delete input schemas and the `ProjectSecretSummary` response type, no value field); verify `bun run typecheck` passes and a schema test rejects a reserved name and an oversized value

## 2. Storage

- [x] 2.1 Add `projectSecrets` to `schema.sqlite.ts` and `schema.pg.ts` with the columns and unique index of D1, and the migration in `packages/server/src/db/migrate.ts`; verify the schema-mirror check in `bun run lint` passes and a migration test creates the table on SQLite
- [x] 2.2 Keep the table's queries inside `packages/server/src/services/project-secrets.ts` (only the server reads it, so it is not a shared repository); verify with service tests for upsert-replaces-value, the unique key across scopes, and cascade on project delete

## 3. Server: management API

- [x] 3.1 Implement `packages/server/src/services/project-secrets.ts` management methods (`list`, `set`, `remove`) returning `Result`, encrypting with `lib/crypto.ts`, enforcing limits and writing `secret.set` / `secret.delete` audit entries without values; verify with service tests for encryption at rest (stored text differs from the value), limits, value-optional update of the sandbox switch, and audit content
- [x] 3.2 Add the `projectSecrets` router to `packages/api` and the port in `packages/server/src/trpc/ports/project-secrets.ts` with the capability rules of D7; verify with port tests for: `manage` required for shared, `steer` for personal, 404 without a role, another member's personal rows neither listed nor deletable, and no response containing a value
- [x] 3.3 Register the group in `scripts/fitness/check-trpc-api.ts` and delete a removed member's personal rows in `project-manager.removeMember`; verify `bun run lint` passes and a test shows the rows gone after removal

## 4. Server: delivery to runners

- [x] 4.1 Implement `resolveThreadSecrets` (D4) in `services/project-secrets.ts`; verify with tests for personal-over-shared, only the thread owner's personal rows, scratch thread empty, sandbox filter applied after override, reserved names dropped at delivery, a decrypt failure failing the whole call with the secret's name, lazy re-encryption, and the `secret.delivered` entry
- [x] 4.2 Add `data:get_project_secrets` to `runner-protocol.ts` and `protocol/runner/v2/operations.proto`, regenerate `packages/shared/src/generated/runner-v2`, wire `grpc/operations-handler.ts` and the handler in `data-message-handlers.ts`; verify the protocol fixtures / codegen check pass and a handler test returns the resolved secrets
- [x] 4.3 Add the `refs` rule to `DATA_SCOPE_RULES`; verify with data-scope tests that a runner outside the project's scope is refused, a runner of a different user is refused by the owner check, a sandbox runner is allowed only for its bound thread, and each refusal is audited

## 5. Runtime: environment and redaction

- [x] 5.1 Add the request to `grpc-operations-adapter.ts` and the runner service provider, and `loadProjectSecretEnv(threadId)` in `agent-startup/`; verify with a test that an "unknown type" refusal from an older server yields no secrets and any other error is returned
- [x] 5.2 Merge the secrets first when composing the agent env in `agent-lifecycle.ts` (order of D3) and fail the start with a thread-visible error when delivery fails; verify with tests that a secret cannot override a `buildAgentEnv` or profile variable, that it overrides an inherited one, that a scratch thread makes no request, and that a delivery error stops the start
- [x] 5.3 Build the per-run redactor and apply it in `agent-message-handler.ts` to message content, tool input and tool output before both the persistence call and `emitWS`, dropping it when the run ends; verify with a handler test that the persisted and emitted strings are identical and contain `[secret:NAME]`

## 6. Client

- [x] 6.1 Add `packages/client/src/data/project-secrets/` (`hooks.ts`, `actions.ts`, API calls through `trpcCall`); verify with tests that a write invalidates the list and a refused write surfaces the server message, and that `fitness:layering` passes
- [x] 6.2 Build `components/settings/ProjectSecretsSettings.tsx` (everything listed in D8: shared and personal lists with the override badges, add / replace dialog, sandbox switch, delete confirmation, the two notices; `data-testid` on every control, theme and font-size variables) and mount it in the project settings, desktop and mobile; verify with component tests that shared controls are disabled without `manage`, a reserved name shows the inline error, no value is rendered after saving, replacing with an empty value field sends no `value`, the name is read-only when replacing, the override badges appear on both rows, and the delete confirmation of an overriding personal secret names the shared fallback; add a Storybook story
- [x] 6.3 Add the secrets sentence to the `steer` level in `ShareThreadButton.tsx` and the `en` / `es` locale strings for the whole feature; verify the dialog test finds the sentence only at the `steer` level and the locale parity check passes

## 7. Documentation and integration

- [x] 7.1 Document the feature in `CLAUDE.md` (a "Project secrets" section: scopes, reserved names, the delivery rule, the sandbox switch, redaction limits) and in `openwiki/`; verify the links resolve and `bun run lint` passes
- [x] 7.2 Cover the chain from `projectSecrets.set` to the agent env in its two halves, split at the data channel (the runtime cannot import the server): the server answers a saved secret to the thread owner's runner (`data-scope.test.ts`), and the runtime puts that answer in the env it hands the orchestrator and fails the start without it (`agent-lifecycle.test.ts`). A steer sharee's follow-up needs no case of its own: the request carries the thread, never the sender
- [x] 7.3 Run `bun run lint`, `bun run typecheck`, the affected test suites and `bunx fallow audit`; verify all pass
