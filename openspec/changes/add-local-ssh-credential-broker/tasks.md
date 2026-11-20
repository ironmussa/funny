## 1. Security contract and shared protocol

- [x] 1.1 Define shared Connector pairing, capability, `RemoteExecutionRequest`, target/operation identifiers, opaque credential-enrolment, signed approval, bounded result, and metadata-only audit types in `packages/shared`.
- [x] 1.2 Add schemas that reject secrets outside the opaque enrolment payload, caller-supplied SSH connection fields, arbitrary commands, unknown operation IDs, invalid typed arguments, and mismatched Connector key bindings.
- [x] 1.3 Define versioned runtime-to-Connector IPC, browser-to-Connector encrypted-enrolment envelope, request digest, error taxonomy, output limits, cancellation, expiry, and replay semantics.
- [x] 1.4 Add protocol/schema tests proving credential values cannot be serialized in standard Funny requests/audits, unsafe fields are rejected, and enrolment envelopes are bound to one runner, Connector key, target, and version.

## 2. Funny Remote Connector

- [x] 2.1 Create the private workspace package `packages/remote-connector` with its own executable entry point, tests, build scripts, internal core/platform boundaries, semantic version, and no runtime/agent import path.
- [x] 2.2 Implement the separately installed Windows, macOS, and Linux `funny-remote-connector` service with a dedicated non-login/service identity, service-owned storage, Unix-socket or named-pipe lifecycle, and startup isolation checks.
- [x] 2.3 Implement protocol/capability negotiation and reject unsupported, too-old, or revoked peers before accepting enrolment or execution requests.
- [x] 2.4 Implement one-time pairing-code verification, Connector-owned enrolment-key generation, public-key registration/rotation, capability reporting, and runner binding.
- [x] 2.5 Implement receipt, validation, decryption, local persistence, rotation, deletion, and non-secret acknowledgement for opaque credential-enrolment envelopes.
- [x] 2.6 Implement signed target configuration caching and validation for fixed connection metadata, host-key pins, limits, environment, opaque credential references, operation templates, and typed argument allowlists.
- [x] 2.7 Implement Connector peer authorization, signed-request validation, replay protection, production-confirmation validation, and target/operation policy enforcement.
- [x] 2.8 Implement non-interactive remote execution with an embedded SSH transport, strict host-key checking, forwarding disabled, no local shell or unsafe interpolation, deterministic POSIX token quoting, timeout/cancellation cleanup, bounded output, and generic failure categories.
- [x] 2.9 Implement one proven-safe native provider abstraction backed by Windows Credential Manager/DPAPI, macOS Keychain, or non-prompting Linux Secret Service; reject providers that expose a secret through child argv, environment, stdout/stderr, IPC, or agent-readable files, and retain the provider abstraction for a future Vault Agent-compatible alternative.
- [x] 2.10 Implement in-memory secret handling and output/audit redaction, then add Connector tests for pairing, negotiation, envelope binding, host-key mismatch, unsafe providers, command injection, cancellation, timeout, output cap, and no-secret logging.

## 3. Connector packaging and lifecycle

- [ ] 3.1 Define the supported OS/architecture matrix and create Windows, macOS, and Linux build pipelines that produce independently versioned Connector executables and installers/packages.
- [ ] 3.2 Add platform installation/service-management actions that create and validate the dedicated identity, service-owned directories, IPC permissions, auto-start registration, and post-install health checks.
- [ ] 3.3 Add checksums, software-bill-of-materials/provenance output, and code-signing/notarization hooks; document how release verification fails closed when required signatures or checksums are invalid.
- [ ] 3.4 Implement administrator-initiated upgrade, repair, and uninstall flows; upgrades preserve pairing/provider entries, replace the service atomically, run compatibility/health validation, and roll back on failure.
- [ ] 3.5 Add packaging tests for clean install, upgrade with preserved credentials, failed-upgrade rollback, repair, and uninstall cleanup on each supported OS.

## 4. Funny runtime, server, persistence, and UI

- [ ] 4.1 Add a runtime Connector client that performs protocol negotiation and health/isolation checks, sends only structured requests, supports cancellation, and fails closed without direct SSH fallback.
- [ ] 4.2 Add architecture/fitness checks preventing runtime, agents, server, and client from importing Connector implementation modules.
- [ ] 4.3 Add server-side Connector registration, pairing-code lifecycle, public-key fingerprint verification, capability/version tracking, compatibility policy, and an opaque-enrolment relay that stores no credential payload.
- [ ] 4.4 Add server-side authorization for human-only target/credential enrolment, project/thread ownership, assigned-runner resolution, target/operation visibility, request signing, and single-use production confirmation issuance.
- [ ] 4.5 Add authenticated UI controls to pair a Connector, manage targets/operations, encrypt passwords locally to a Connector public key, show enrolment/rotation and compatibility status without secret fields, confirm production operations, dispatch requests, and render bounded untrusted results.
- [ ] 4.6 Persist metadata-only remote-execution audit records and expose authorized history views without raw argv, connection metadata, credential references, credential envelope contents, or unredacted output.
- [ ] 4.7 Add end-to-end tests for pairing denial, incompatible/mismatched/rotated keys, opaque-enrolment relay/retry, authorization denial, runner mismatch, missing Connector, forged/expired/replayed approvals, production confirmation, output redaction, and audit completeness.

## 5. Deployment and operational validation

- [ ] 5.1 Add Windows, macOS, and Linux installation documentation for dedicated Connector/runtime/agent identities, package signature/checksum verification, pairing/key rotation, named-pipe or Unix-socket permissions, host-key enrolment/rotation, and native provider setup.
- [ ] 5.2 Publish a server/runtime/Connector compatibility matrix plus upgrade, repair, rollback, and uninstall guidance.
- [ ] 5.3 Document the security model and browser-enrolment threat boundary; document incompatibility of `sshpass`, `SSH_ASKPASS`, agent-readable keychain commands, environment variables, and password prompts, plus Vault/Boundary/Teleport migration options.
- [ ] 5.4 Provide platform-specific validation commands or checklists proving agents cannot connect to the Connector or read its storage, valid runtimes can execute only configured operations, and Funny persists no credential plaintext or envelope contents.
- [ ] 5.5 Add an incident/rollback runbook for disabling targets, unpairing/stopping a Connector, rotating/deleting credentials or Connector keys, host-key mismatch, incompatible releases, failed upgrades, and suspected credential exposure.

## 6. Verification and commits

- [ ] 6.1 Run focused unit, integration, packaging, upgrade, and end-to-end security tests for the Connector, runtime, server, shared protocol, and UI.
- [ ] 6.2 Run `bun run lint` and `bun run typecheck` with the complete change.
- [ ] 6.3 Create separate coherent commits: shared security contract; Connector package/core; platform providers and installers; runtime/server/UI integration; tests; operations/documentation.
