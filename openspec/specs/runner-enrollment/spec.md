# runner-enrollment Specification

## Purpose

TBD - created by archiving change device-link-runner-enrollment. Update Purpose after archive.

## Requirements

### Requirement: Runner boots with zero configuration into enrollment

The runner MUST enter device-link enrollment against a server URL instead of
aborting when no credentials resolve (no persisted credentials file for the
target server, and no invite token or shared secret via flag or env), and it
MUST surface a short human-readable user code to the operator. The runner MUST
still honor explicitly supplied credentials: when a token or secret is provided
via flag or env, it MUST skip enrollment and use the existing register/resume
path unchanged.

#### Scenario: Bare start enters enrollment

- **WHEN** `funny` is started with a known server URL but no token, no secret, and no persisted credentials for that server
- **THEN** the runner does not exit with an error
- **AND** it requests an enrollment code from the server and prints a short user code with instructions to approve it in the funny UI

#### Scenario: Explicit credentials skip enrollment

- **WHEN** `funny --team <url> --token <invite> --secret <secret>` is started
- **THEN** the runner uses the existing invite-token registration path and does not start a device-link enrollment

#### Scenario: Persisted credentials skip enrollment

- **WHEN** a valid `runner-credentials.json` exists for the target server
- **THEN** the runner resumes its session with the stored bearer token and does not start a device-link enrollment

### Requirement: Enrollment start endpoint issues a user code and poll token

The server SHALL expose `POST /api/runners/enroll/start` as an unauthenticated
endpoint. Given a runner's `hostname` and `os`, it SHALL create an enrollment
record in `pending` state and return a short, human-readable `userCode` and a
long, high-entropy `pollToken`. The `userCode` SHALL be shown to a human; the
`pollToken` SHALL be retained by the runner and never shown to a human. Each
enrollment SHALL expire after a bounded lifetime, and the endpoint SHALL be
rate-limited.

#### Scenario: Start returns codes

- **WHEN** a runner posts its hostname and os to `/api/runners/enroll/start`
- **THEN** the server creates a pending enrollment and responds with a short `userCode` and a long `pollToken`
- **AND** the response carries an expiry (or interval) the runner can use to pace polling

#### Scenario: Start requires no authentication

- **WHEN** the start request arrives with no session cookie, bearer token, or shared secret
- **THEN** the server still accepts it (the endpoint is public)

#### Scenario: User codes are unguessable in aggregate

- **WHEN** an attacker attempts to brute-force user codes against the approval action
- **THEN** rate limiting and/or sufficient code entropy prevents enumeration within the enrollment lifetime

### Requirement: A logged-in user approves an enrollment, binding it to their account

The server SHALL expose an authenticated approval action that, given a
`userCode`, looks up the pending enrollment and shows the requesting runner's
`hostname`, `os`, and originating IP to the approver. On approval, the server
SHALL bind the enrollment to the approving user's account, transition it to
`approved`, register the runner under that user, and prepare the runner's
credential payload. Approval SHALL fail for an unknown, expired, or
already-consumed code.

#### Scenario: Approval binds runner to approver

- **WHEN** a logged-in user submits a valid pending `userCode` and approves
- **THEN** the server registers a runner owned by that user and marks the enrollment approved

#### Scenario: Approver sees runner metadata before approving

- **WHEN** a user enters a valid `userCode` in the link-runner UI
- **THEN** the server returns the runner's hostname, os, and originating IP so the user can confirm it is their runner

#### Scenario: Expired or unknown code is rejected

- **WHEN** a user submits a `userCode` that does not exist or has expired
- **THEN** the approval action returns an error and no runner is registered

#### Scenario: A code cannot be approved twice

- **WHEN** a `userCode` that has already been approved is submitted again
- **THEN** the approval action rejects it

### Requirement: Poll endpoint delivers credentials only after approval

The server SHALL expose `POST /api/runners/enroll/poll` as an unauthenticated
endpoint keyed by the `pollToken`. While the enrollment is `pending` it SHALL
return a `pending` status and no credentials. Once `approved` it SHALL return,
exactly once, the runner's registration payload: the runner id, the runner
bearer token, and the forwarded-identity secret the runner needs to sign/verify
proxied requests. An unknown, expired, or already-consumed `pollToken` SHALL be
rejected.

#### Scenario: Poll before approval returns pending

- **WHEN** the runner polls with a valid `pollToken` for a still-pending enrollment
- **THEN** the server responds with a pending status and no credentials

#### Scenario: Poll after approval returns credentials

- **WHEN** the runner polls with a valid `pollToken` for an approved enrollment
- **THEN** the server responds with the runner id, the runner bearer token, and the forwarded-identity secret

#### Scenario: Credentials are delivered once

- **WHEN** the runner polls again after already receiving its credentials
- **THEN** the server does not re-issue the credentials for that consumed enrollment

#### Scenario: Invalid poll token is rejected

- **WHEN** a poll request presents an unknown or expired `pollToken`
- **THEN** the server rejects it without leaking enrollment state

### Requirement: Runner persists delivered credentials and connects without manual secrets

On receiving its credentials from the poll endpoint, the runner SHALL persist
the server URL, runner id, bearer token, and forwarded-identity secret to its
local credentials file (restricted permissions), load the forwarded-identity
secret into its process configuration, and proceed into the normal connected
runner lifecycle (heartbeat, tunnel, task polling). After enrollment the
operator SHALL NOT have manually supplied any token or shared secret.

#### Scenario: Runner connects after approval

- **WHEN** the runner receives credentials from the poll endpoint
- **THEN** it persists them, configures the forwarded-identity secret, and appears online to the server within the normal heartbeat window

#### Scenario: Restart after enrollment is transparent

- **WHEN** an enrolled runner restarts
- **THEN** it resumes using the persisted credentials (including the forwarded-identity secret) without a new enrollment

#### Scenario: Proxied requests succeed without an out-of-band secret

- **WHEN** a browser request is proxied through the server to an enrolled runner
- **THEN** forwarded-identity verification succeeds using the secret delivered during enrollment, with no shared secret typed by the operator

### Requirement: ConnectRunnerCard reflects the device-link flow honestly

The runner connection UI SHALL NOT present a command that the CLI would reject.
It SHALL present the device-link path: a zero-configuration boot command for a
generic machine and a "Link a runner" code-entry/approval affordance. The prior
command that omitted the required shared secret SHALL be removed.

#### Scenario: No dishonest command shown

- **WHEN** a user opens the runner connection UI
- **THEN** it does not display a `--token`-only command that the CLI would abort on for missing `--secret`

#### Scenario: Link-a-runner affordance present

- **WHEN** a user opens Settings ▸ Runners
- **THEN** a "Link a runner" affordance lets them enter a user code and approve a pending runner
