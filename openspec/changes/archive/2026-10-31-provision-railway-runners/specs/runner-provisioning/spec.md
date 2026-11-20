# Spec Delta

## Purpose

Lets a user deploy a dedicated runner for a project onto remote infrastructure (Railway first) from Project Settings, with the runner connecting and binding itself to the project automatically.

## ADDED Requirements

### Requirement: Infrastructure connections

Users SHALL be able to add, test, list and delete infrastructure connections. A connection SHALL identify its provider (only `railway` initially) and store its credential encrypted at rest. Credentials SHALL never be returned to the client after creation nor written to logs.

#### Scenario: Adding a valid Railway token

- **WHEN** a user adds a Railway token in Settings
- **THEN** the system validates it against Railway, stores it encrypted, and shows the connection with its detected scope (account/workspace or project)

#### Scenario: Invalid token

- **WHEN** a user adds a token Railway rejects
- **THEN** the connection is not saved and the error is shown

### Requirement: Provider abstraction

Provisioning SHALL go through a provider interface supporting credential validation, provisioning, status, redeploy and destroy. The UI SHALL list available providers; providers without an implementation SHALL NOT be selectable.

#### Scenario: Provider list

- **WHEN** a user opens the deploy panel
- **THEN** Railway is selectable as the infrastructure provider

### Requirement: Deploy dedicated runner to Railway

From a project's settings, a user with a Railway connection SHALL be able to deploy a dedicated runner. The system SHALL create or reuse the Railway project/service, attach a persistent volume, configure the runner variables (server URL, data dir, tunnel-only mode, provisioning token) and start a deployment of the runner built from the funny repository at the revision matching the server version. No provider secrets other than the provisioning token SHALL be stored as service variables.

#### Scenario: Deploy with account/workspace token

- **WHEN** the user deploys using an account or workspace token
- **THEN** a new Railway project is created for the funny project with one runner service and a volume

#### Scenario: Deploy with project token

- **WHEN** the user deploys using a project-scoped token
- **THEN** the runner service is created inside that existing Railway project

#### Scenario: Server URL auto-detected

- **WHEN** the server runs on Railway or is accessed through a public URL
- **THEN** the runner is configured with that URL without any manual setting

#### Scenario: Server not publicly reachable

- **WHEN** the only known server URL is a loopback or private address and no override is configured
- **THEN** deploy is unavailable and the UI explains that remote runners require the publicly hosted funny server, without asking the user to configure any URL

### Requirement: Zero-touch enrollment

The server SHALL issue a provisioning token per deployment that is single-use, expires within a bounded time, and is bound to the user and project. A runner registering with a valid token SHALL be created as a `dedicated` runner, set as the project's runner, and SHALL NOT require manual approval. Reuse or expiry of the token SHALL be rejected.

#### Scenario: Runner connects automatically

- **WHEN** the deployed runner starts and registers with its provisioning token
- **THEN** it appears online in Project Settings as the project's dedicated runner without any approval step

#### Scenario: Token replay

- **WHEN** a second registration uses an already consumed provisioning token
- **THEN** it is rejected and audited

#### Scenario: Redeploy keeps identity

- **WHEN** the runner container restarts with its persisted credentials on the volume
- **THEN** it reconnects as the same runner without a new provisioning token

### Requirement: Repository bootstrap

After a provisioned runner connects, the system SHALL clone the project's repository onto the runner's volume using the project's resolved git credential, and record the path as the project's location on that runner. A failed clone SHALL leave the deployment in a `failed` state with the error visible.

#### Scenario: Successful bootstrap

- **WHEN** the runner connects for the first time
- **THEN** the repository is cloned and the project becomes usable on that runner

#### Scenario: Project without remote

- **WHEN** a local project with no git remote is deployed
- **THEN** the repository creation offer is shown before any Railway resource is created

### Requirement: Agent profiles on provisioned runners

A project's bound Claude agent profile SHALL work on its provisioned runner without per-runner setup. Profile config directories SHALL be stored home-relative: an absolute path inside the user's home SHALL be normalized to `~/…` when the profile is saved, and SHALL resolve against the runner's home (persisted on the runner volume).

#### Scenario: Absolute path normalized

- **WHEN** a user saves a profile with config dir `/home/alice/.claude-work` while their home is `/home/alice`
- **THEN** it is stored as `~/.claude-work` and resolves to the runner's home on every runner

### Requirement: Headless Claude credential per profile

Each Claude subscription profile SHALL be able to hold a long-lived headless token obtained once through a single browser approval on the user's general runner. The token SHALL be stored encrypted on the server, never returned to the client, and delivered per operation to whichever runner executes the profile. Runners SHALL NOT require interactive login when the profile holds a valid token. Profiles using an API key need no extra step.

#### Scenario: New runner without login

- **WHEN** a dedicated runner is deployed for a project whose profile already holds a headless token
- **THEN** agents run on it immediately without any login prompt

#### Scenario: Profile without token at deploy time

- **WHEN** the user deploys a runner and the project's Claude profile has no headless token
- **THEN** the deploy flow offers the one-time approval and continues automatically once it completes

#### Scenario: Token revoked or expired

- **WHEN** Claude rejects the profile's headless token
- **THEN** the user is prompted to re-approve once for the profile, not once per runner

### Requirement: Repository creation for projects without remote

When a project selected for deployment has no git remote, the deploy flow SHALL offer to create a private repository on the user's GitHub account using the project's resolved git credential, set it as the remote and push the current branch, then continue deploying.

#### Scenario: One-click repository creation

- **WHEN** the user accepts creating a repository for a project without remote
- **THEN** a private GitHub repository is created, the branch is pushed, and the runner clones it

#### Scenario: User declines

- **WHEN** the user declines repository creation
- **THEN** deploy does not proceed and nothing is created on Railway

### Requirement: Remote project creation

Users SHALL be able to add a project by repository URL and infrastructure connection, without a local folder or general runner; the system SHALL create the project and deploy its dedicated runner in one flow.

#### Scenario: Add remote project

- **WHEN** a user chooses "Remote (Railway)", enters a repository URL and selects a connection
- **THEN** the project is created, its runner is deployed, and the project opens once the runner is online and the repository is cloned

### Requirement: Deployment lifecycle

Project Settings SHALL show the deployment status (`provisioning`, `building`, `connecting`, `online`, `offline`, `failed`) and SHALL allow redeploy and destroy. Redeploy SHALL update the runner to the server's version while preserving the volume. Destroy SHALL remove the runner and, unless the user chooses to keep them, the Railway resources created by funny; resources funny did not create SHALL never be deleted.

#### Scenario: Build failure

- **WHEN** the Railway deployment fails
- **THEN** status shows `failed` with the provider's error and a retry action

#### Scenario: Destroy keeping resources

- **WHEN** the user destroys the runner choosing to keep Railway resources
- **THEN** the runner is removed from funny and the Railway project/service remain untouched
