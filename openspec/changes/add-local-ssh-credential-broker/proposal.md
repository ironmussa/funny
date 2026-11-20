## Why

Agents running through Funny currently need a user to enter SSH passwords in an interactive prompt when they operate on a remote host. Supplying those passwords in a chat, shell command, environment variable, or repository file leaks them to the agent, logs, and/or processes that are not intended to hold credentials.

Funny needs a first-party, local-first Remote Connector that works consistently on Windows, macOS, and Linux. It must let an authorized runner request a named remote operation without disclosing a password to the agent or persisting plaintext credentials in Funny's database.

## What Changes

- Add a first-party `packages/remote-connector` workspace package that builds and
  releases the separately installed `Funny Remote Connector` product. It
  executes allowed remote commands for a named target and returns only their
  results.
- Give the Connector its own executable entry point, platform installers,
  release/version metadata, service-management lifecycle, and compatibility
  policy. It is not bundled into or loaded as a library by the agent/runtime.
- Add human-only target and credential enrolment in Funny. The browser encrypts a credential envelope to the paired Connector before it reaches Funny's backend; Funny relays it but does not persist it. The Connector decrypts and stores it in its OS-protected local credential store.
- Add Connector pairing, public-key registration, capability reporting, credential lifecycle, and target configuration containing non-secret connection metadata, pinned host-key fingerprints, command policy, and production-approval requirements.
- Add authorization, audit records, redaction, timeouts, and failure handling for remote-command requests.
- Document the required deployment isolation on Windows, macOS, and Linux: the Connector must run under a distinct OS security identity from agent processes. The feature is unavailable when that isolation cannot be established.
- Do not add arbitrary interactive SSH sessions, raw `ssh` access, password fields in the UI/API, `sshpass` usage by agents, or password fallback to prompts.

## Capabilities

### New Capabilities

- `remote-ssh-targets`: Define and validate named SSH targets with immutable host identity and least-privilege policy.
- `brokered-remote-execution`: Execute authorized commands through a local broker without returning credential material.
- `local-credential-provider`: Enrol, persist, resolve, rotate, and delete password credentials only within an isolated Connector process.
- `remote-connector-enrollment`: Pair an authenticated Funny runner with a Connector and deliver end-to-end encrypted credential enrolments to it.
- `remote-execution-governance`: Apply confirmation, audit, redaction, and safe error handling to brokered remote operations.

### Modified Capabilities

<!-- None. -->

## Impact

- Adds the private workspace package `packages/remote-connector`, which owns the
  Connector executable, platform adapters, installers, service lifecycle, and
  release artifacts for Windows, macOS, and Linux.
- Adds runner-side Connector integration in `packages/runtime`; runtime depends
  only on versioned protocol types and schemas exported by `packages/shared`,
  not on Connector implementation modules.
- Adds build and release automation for signed/checksummed platform artifacts,
  compatibility reporting, installation, upgrade, repair, and uninstall
  documentation.
- Adds target-management, Connector pairing, credential-enrolment, and remote-operation controls to the client only after the runner/Connector security boundary is in place.
- Does not migrate or expose existing Git/GitHub credentials, and does not change Funny's existing agent terminal permissions.
