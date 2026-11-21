# Proposal

## Why

A project's agents need credentials (a database URL, an API key for a third-party service) that are not in the repository. On a local runner the project's `.env` is already on disk, but a sandbox starts from a clean clone and each team member has a different machine, so today those threads start without the values and the user pastes them into the chat. funny has an encrypted keyring (`packages/shared/src/lib/crypto.ts`) and per-user provider keys, but no place to keep a project's own secrets.

## What Changes

- Add **project secrets**: named values stored encrypted on the server, per project, and handed to the agent as environment variables when a thread of that project starts.
- Two scopes. A **shared** secret belongs to the project and reaches every member who runs an agent in it. A **personal** secret belongs to one member and overrides the shared secret of the same name for the threads that member owns.
- A secret's value is write-only in the browser: the UI and the API list names and metadata, never values.
- Secret names that would change how the runner or the agent itself behaves (`PATH`, `LD_*`, `NODE_OPTIONS`, `GIT_*`, `GH_TOKEN`, `ANTHROPIC_*`, `FUNNY_*`, provider key variables, …) are refused, and a project secret never overrides a variable funny sets for the agent.
- Each secret has an **available in sandbox** switch, off by default. A sandbox runner receives only the secrets with the switch on.
- A follow-up sent by a `steer` sharee starts the owner's agent with the owner's secrets. The share dialog says so.
- Known secret values are replaced with `[secret:NAME]` in the messages and tool output funny stores and shows. This is best effort and does not hide the value from the model.
- Every write and every delivery is audited (`secret.set`, `secret.delete`, `secret.delivered`).
- A **Secrets** section in the project settings.

Out of scope, left for a second phase: secrets in the terminal panel and in project startup commands, writing secrets to a worktree `.env` file, references to an external password manager (`op://…`), and an agent tool that asks the user for a secret in a private card.

## Capabilities

### New Capabilities

- `project-secrets`: storing, listing, changing and deleting a project's shared and personal secrets, who may do each, which names are refused, how the values reach an agent (including sandbox and steer-shared threads), redaction of stored and displayed output, and auditing.

### Modified Capabilities

<!-- None. Thread and project access rules are used as they are. -->

## Impact

- **Database** (`packages/shared/src/db/schema.{sqlite,pg}.ts`, `packages/server/src/db/migrate.ts`): new `project_secrets` table.
- **Shared** (`packages/shared`): contract schemas `contracts/project-secrets.ts`, the secret-name rules, the redaction function, the new `data:get_project_secrets` message in `runner-protocol.ts`.
- **Runner protocol** (`protocol/runner/v2/operations.proto` and its generated code): one new operation. A runner older than this change never asks, so its agents start without project secrets.
- **API** (`packages/api`, `packages/server/src/trpc/ports/project-secrets.ts`): new tRPC group `projectSecrets`. No REST routes, and nothing in the public API v1.
- **Server** (`services/data-scope.ts`, `services/data-message-handlers.ts`, `services/grpc/operations-handler.ts`): scope rule and handler for the new message; audit records.
- **Runtime** (`services/agent-lifecycle.ts`, `services/agent-startup/agent-env.ts`, `services/agent-message-handler.ts`): fetch the secrets on each agent start, merge them into the agent environment, redact before persisting and emitting.
- **Client** (`packages/client/src/data/project-secrets/`, a settings component, `ShareThreadButton.tsx`, locales).
- **Security**: a shared secret is readable by every member who can run an agent in the project, and by a `steer` sharee of any thread in it. The feature does not change runner isolation, the steer allow-list or the sandbox GitHub rules.
