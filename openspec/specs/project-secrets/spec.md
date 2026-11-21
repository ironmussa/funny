# project-secrets Specification

## Purpose

Lets a project keep named secret values on the server, encrypted, and hands them to the project's agents as environment variables, so threads on sandboxes and on other members' machines have the credentials they need without anyone pasting them into a chat.

## Requirements

### Requirement: Shared and personal secrets

A project SHALL hold two kinds of secret. A shared secret belongs to the project. A personal secret belongs to one member of the project. Within a project, a name SHALL be unique among the shared secrets, and unique among one member's personal secrets. Secret values SHALL be encrypted at rest.

#### Scenario: Shared and personal secret with the same name

- **WHEN** a project has a shared secret `DATABASE_URL` and a member saves a personal secret `DATABASE_URL`
- **THEN** both are stored, and the other members' personal secrets are unaffected

#### Scenario: Saving an existing name replaces its value

- **WHEN** a member saves a secret whose name and scope already exist
- **THEN** the stored value is replaced and no second secret is created

#### Scenario: Deleting a project removes its secrets

- **WHEN** a project is deleted
- **THEN** all of its shared and personal secrets are deleted

### Requirement: Who may manage secrets

Creating, changing or deleting a shared secret SHALL require the `manage` capability on the project. Creating, changing or deleting a personal secret SHALL require the `steer` capability, and a member SHALL only ever act on their own personal secrets. Listing SHALL require the `view` capability and SHALL return the project's shared secrets and the caller's own personal secrets. A caller with no role on the project SHALL get the same answer as for a project that does not exist.

#### Scenario: Contributor tries to change a shared secret

- **WHEN** a member with `steer` but without `manage` saves or deletes a shared secret
- **THEN** the request is refused with 403 and nothing changes

#### Scenario: Contributor saves a personal secret

- **WHEN** a member with `steer` saves a personal secret
- **THEN** the secret is stored for that member only

#### Scenario: Personal secrets of another member are not listed

- **WHEN** a member lists the project's secrets
- **THEN** the list contains the shared secrets and that member's personal secrets, and none of another member's personal secrets

#### Scenario: Caller without a role

- **WHEN** a user with no role on the project lists or saves a secret
- **THEN** the request is answered with 404

### Requirement: Values are write-only

No response to a browser or API client SHALL contain a secret's value. Listing SHALL return, for each secret, its name, scope, sandbox availability, who last changed it and when.

#### Scenario: Listing after saving

- **WHEN** a member saves a secret and then lists the project's secrets
- **THEN** the secret appears with its name and metadata and without its value

#### Scenario: Changing sandbox availability without retyping the value

- **WHEN** a member changes only a secret's sandbox availability
- **THEN** the stored value is kept

#### Scenario: Opening a stored secret to replace it

- **WHEN** a member opens a stored secret in the settings UI
- **THEN** the value field is empty, and saving it empty keeps the stored value

### Requirement: Secret names and values are validated

A secret name SHALL be a valid environment variable name (letters, digits and underscores, not starting with a digit) of at most 128 characters. The system SHALL refuse reserved names: names that change how a process is loaded or located, names funny or the agent provider uses for its own configuration and credentials, and git and GitHub credential names. A value SHALL be non-empty and at most 32 KiB. A project SHALL hold at most 100 shared secrets, and a member at most 100 personal secrets per project.

#### Scenario: Reserved name

- **WHEN** a member saves a secret named `NODE_OPTIONS`, `LD_PRELOAD`, `PATH`, `GH_TOKEN`, `ANTHROPIC_BASE_URL` or `FUNNY_ASSETS_DIR`
- **THEN** the request is refused with a message naming the reason, and nothing is stored

#### Scenario: Invalid name

- **WHEN** a member saves a secret named `1TOKEN` or `MY-TOKEN`
- **THEN** the request is refused and nothing is stored

#### Scenario: Multi-line value

- **WHEN** a member saves a secret whose value is a multi-line PEM key under the size limit
- **THEN** the value is stored unchanged

### Requirement: Agents receive the project's secrets as environment variables

When an agent starts for a thread that belongs to a project, its environment SHALL contain that project's secrets. The personal secrets used SHALL be those of the thread's owner, and a personal secret SHALL take the place of the shared secret of the same name. A project secret SHALL NOT replace a variable that funny sets for the agent. Threads without a project SHALL receive none. The values SHALL be read from the server at each agent start and SHALL NOT be written to disk by the runner.

#### Scenario: Shared secret reaches the agent

- **WHEN** a project has a shared secret `STRIPE_KEY` and a member starts a thread in it on their own runner
- **THEN** a command run by the agent sees `STRIPE_KEY` with the stored value

#### Scenario: Personal secret overrides the shared one

- **WHEN** the thread's owner has a personal secret with the same name as a shared secret
- **THEN** the agent sees the owner's personal value

#### Scenario: Another member's personal secret is not used

- **WHEN** a member starts a thread and a different member has a personal secret in the same project
- **THEN** the agent does not receive that other member's secret

#### Scenario: A changed value applies on the next start

- **WHEN** a secret's value is changed while an agent is running
- **THEN** the running agent keeps the old value, and the next agent start for the thread uses the new one

#### Scenario: Scratch thread

- **WHEN** an agent starts for a scratch thread
- **THEN** no project secret is requested or delivered

#### Scenario: A secret cannot be read

- **WHEN** a stored secret cannot be decrypted at agent start
- **THEN** the agent does not start and the thread shows an error naming the secret, and the agent is never started with that secret silently missing

### Requirement: Only the runner that runs the thread receives the secrets

Secret values SHALL be delivered only to a runner that is allowed to serve the thread's project and that belongs to the thread's owner, or to the thread's own sandbox runner. Any other request SHALL be refused.

#### Scenario: Runner outside the project's scope

- **WHEN** a runner that may not serve the project asks for the secrets of one of its threads
- **THEN** the request is refused and no value is returned

#### Scenario: Sandbox runner asks about another thread

- **WHEN** a sandbox runner asks for the secrets of a thread other than the one it is bound to
- **THEN** the request is refused

### Requirement: Sandbox availability is opt-in per secret

Each secret SHALL carry a sandbox availability setting that is off when the secret is created. A sandbox runner SHALL receive only the secrets whose setting is on. The setting SHALL be evaluated for the secret that would be delivered after personal override.

#### Scenario: Secret not available in sandbox

- **WHEN** a sandbox thread starts and a secret has sandbox availability off
- **THEN** the sandbox agent does not receive it

#### Scenario: Secret available in sandbox

- **WHEN** a sandbox thread starts and a secret has sandbox availability on
- **THEN** the sandbox agent receives it

#### Scenario: Personal override decides for its name

- **WHEN** a shared secret has sandbox availability on and the thread owner's personal secret of the same name has it off
- **THEN** the sandbox agent receives neither value for that name

### Requirement: Steer-shared threads run with the owner's secrets

When a `steer` sharee sends a follow-up to a thread, the agent SHALL start with the same secrets it would have if the owner had sent the message. The dialog that shares a thread at the `steer` level SHALL state that the sharee can reach the project's secrets through the agent.

#### Scenario: Follow-up from a steer sharee

- **WHEN** a `steer` sharee sends a follow-up to a thread in a project with secrets
- **THEN** the agent starts on the owner's runner with the owner's shared and personal secrets

#### Scenario: Share dialog warning

- **WHEN** the owner selects the `steer` level in the share dialog
- **THEN** the dialog states that the sharee can reach the project's secrets through the agent

### Requirement: Stored and displayed output is redacted

Before a message, a tool call input or a tool output of a thread is stored or sent to browsers, every occurrence of a delivered secret value of 8 characters or more SHALL be replaced with `[secret:NAME]`. The settings UI SHALL state that redaction is best effort and that the model can see a value the agent prints.

#### Scenario: Agent prints a secret

- **WHEN** the agent runs a command whose output contains a delivered secret's value
- **THEN** the stored tool output and the output shown in the browser contain `[secret:NAME]` in its place

#### Scenario: Short value

- **WHEN** a delivered secret's value is shorter than 8 characters
- **THEN** it is not redacted

### Requirement: Secret operations are audited

The system SHALL record an audit entry when a secret is created or changed, when it is deleted, and when secrets are delivered to a runner. An entry SHALL identify the actor, the project and the secret names, and for a delivery the thread and the runner. No audit entry SHALL contain a secret value.

#### Scenario: Saving a secret

- **WHEN** a member saves a secret
- **THEN** an audit entry records the member, the project, the secret's name and scope, and no value

#### Scenario: Delivery to a runner

- **WHEN** secrets are delivered for an agent start
- **THEN** an audit entry records the thread, the runner and the names delivered

#### Scenario: Refused delivery

- **WHEN** a request for a thread's secrets is refused
- **THEN** an audit entry records the refusal and the requesting runner
