## Context

Funny agents can run processes on a runner host. Asking them to supply an SSH
password exposes it to the model, terminal capture, shell history, process
inspection, or logs. A secure password feature therefore needs a process and
OS-identity boundary that an agent cannot invoke to retrieve a secret.

This change makes that boundary a first-party product: **Funny Remote
Connector**. One Connector is paired to a Funny runner and provides the same
user workflow on Windows, macOS, and Linux (including Zorin OS). It runs under
a service identity distinct from Funny's runtime and agent processes.

Its source lives in the monorepo as `packages/remote-connector`, but its
deployment unit is independent. Funny builds the package into platform-specific
executables/installers and installs it as an OS service. The runtime never
imports Connector implementation code or starts the Connector in-process.

The Connector owns the credential lifecycle. A human enrols a password in
Funny's UI, which encrypts it to the paired Connector before the backend sees
it. Funny only relays the opaque envelope while the Connector is online; it
persists status and version metadata, never the envelope or plaintext. The
Connector decrypts and stores the credential in a native provider available
only to its service identity: Credential Manager/DPAPI on Windows, Keychain on
macOS, or Secret Service-compatible storage on Linux.

## Goals / Non-Goals

**Goals:**

- Provide a Funny-managed workflow to pair a Connector, enrol/rotate/delete a
  remote password, and execute named SSH operations on all supported desktop
  operating systems.
- Keep plaintext credentials outside Funny's backend, database, logs, runtime,
  protocol payloads, and agent environment.
- Pin host keys, restrict commands to typed named operations, require bound
  approval for production, and make every decision auditable without secrets.
- Fail closed if pairing, Connector isolation, credential resolution, host
  verification, authorization, or policy validation fails.
- Keep a provider abstraction so Vault, Boundary, or SSH certificates can be
  introduced later without changing Funny's remote-operation API.
- Give the Connector an independently testable, releasable, installable, and
  upgradable package boundary while keeping its public contract in
  `packages/shared`.

**Non-Goals:**

- Interactive shells, port forwarding, SFTP/SCP, terminal streaming, or a
  generic agent-accessible `ssh` tool.
- Allowing agents to create targets, enrol credentials, set host/user/port,
  choose a credential, provide an arbitrary command, or self-approve actions.
- Defending password entry against a compromised Funny web origin, malicious
  browser extension, or endpoint that can read input before browser encryption.
- Making an approved operation harmless if an authorized caller asks to run it.

## Decisions

### Rust executable with generated shared-contract conformance

`packages/remote-connector` builds `funny-remote-connector` as a Rust
executable. Rust owns the service process, protected IPC, local persistence,
cryptography, credential-provider access, and embedded SSH transport. This
keeps secrets out of a JavaScript heap and allows the Windows named pipe to be
created with an explicit restrictive DACL rather than the unsafe default
security descriptor.

`packages/shared` remains the source of truth for the versioned JSON wire
contract. It exports canonical protocol fixtures and schema metadata used by
Connector conformance tests. The Rust types are private implementation types
that must round-trip those fixtures; they are not a second public contract.
Protocol changes therefore fail validation unless the shared schemas and the
Connector implementation agree.

The initial native stack is Tokio for asynchronous service/IPC lifecycle,
`russh` for non-interactive SSH, one native credential-provider abstraction
backed by `keyring` for Credential Manager/DPAPI and Keychain plus a
non-prompting Secret Service adapter on Linux, and `zeroize`-backed secret
containers. The Linux adapter sets its maximum prompt timeout to zero and
rejects locked collections instead of inheriting `keyring` 3.x's interactive
unlock behavior. Windows service control and named-pipe DACLs use Win32 APIs
directly. Unsupported provider or isolation configurations fail closed.

### First-party Connector rather than a per-platform integration

Funny will own the Connector source in the private workspace package
`packages/remote-connector`. The package produces a separately installable
`funny-remote-connector` service and platform artifacts rather than a library
that the runtime or agent can import. It has a single protocol and product
workflow on every OS, while encapsulating platform details internally:
Unix-domain socket plus peer checks on macOS/Linux and a named pipe with
restrictive DACL plus client-token validation on Windows. The service identity
is non-login and its storage/configuration is inaccessible to the agent
identity.

The runtime sends a structured request `{ requestId, targetId, operationId,
arguments, actor, approval }`, never a password or connection field. The
Connector returns bounded result data, timestamps, and non-secret errors.
Runtime direct SSH, `sshpass`, `SSH_ASKPASS`, secret-store CLIs, and password
prompts are prohibited fallbacks.

This gives Funny a coherent experience rather than asking users to install and
operate Vault or Boundary. Those products remain optional future providers.

### Package ownership and dependency direction

`packages/remote-connector` owns the service entry point, remote-execution
application logic, embedded SSH adapter, credential-provider interfaces and
platform implementations, local persistence, IPC server, service controls, and
packaging metadata. Platform-specific code sits behind internal interfaces so
the authorization and execution core is shared across Windows, macOS, and
Linux.

`packages/shared` owns only the versioned wire contract, validation schemas,
capability/version negotiation, request/result types, and stable error codes.
`packages/runtime` owns the IPC client and Connector health integration.
`packages/server` owns registration, authorization, signing, relay, and audit
coordination. `packages/client` owns pairing, target management, browser
encryption, confirmation, and status UI.

The dependency direction is:

```text
client/server/runtime ──► shared contract ◄── remote-connector
runtime ── protected local IPC ──► installed remote-connector service
```

Neither `runtime` nor any agent-facing package may import
`packages/remote-connector`, access its storage/provider adapters, or invoke its
internal executable modes. This preserves the security boundary in development
as well as production.

### Independent distribution and compatibility

Connector releases use their own semantic version and declare supported
protocol versions and capabilities during pairing and health checks. Funny
enables a feature only when the runtime/server and Connector negotiate a
compatible protocol; an unknown, too-old, or revoked Connector fails closed
without an automatic direct-SSH fallback.

Release automation builds platform-native artifacts for the supported Windows,
macOS, and Linux architectures, produces checksums and provenance, and supports
code signing/notarization where the platform requires it. Installation creates
the dedicated service identity, service-owned data directories, IPC
permissions, and auto-start registration. Upgrades must preserve pairing and
credential-provider entries, use an atomic service replacement, and roll back
the executable/configuration schema if health validation fails. Updates are
administrator-initiated in the initial release; silent self-update is out of
scope.

### Pairing and end-to-end credential enrolment

At installation, the Connector generates a versioned enrolment key pair under
its service identity and registers its public key, key fingerprint, capability
descriptor, and one-time pairing code. A human verifies the same short code in
Funny before the server binds the Connector to a runner. The server retains only
the public key and pairing metadata.

Only a human with target-management permission can enrol or replace a password.
The browser encrypts a credential envelope to the paired public key and binds
it as authenticated data to runner ID, Connector key version, target ID,
credential version, and expiry. Funny relays the opaque envelope only to the
online matching Connector. The Connector verifies the binding, decrypts it,
stores the secret locally, and acknowledges only a success/failure status. The
browser clears the password and encryption material after submission.

This protects credentials from Funny's data plane, persistence layer, and audit
logs. It does not protect a password from code that controls the browser before
encryption. A later high-assurance mode can use a signed local Connector UI/CLI
for enrolment; it is deliberately separate from the initial web workflow.

### Signed declarative targets and operation allowlists

Humans create target metadata and named operations through Funny. Funny signs
that configuration and the Connector caches it in service-owned storage outside
the repository. A target fixes SSH user, host, port, host-key fingerprints,
credential reference, environment, and limits. Operations have fixed remote
command templates and typed validated arguments; no caller can pass a shell
string or override connection metadata.

The Connector uses an embedded SSH transport with a private authentication API,
so a password is supplied from memory without a command line, environment,
child helper, or prompt. It verifies only Connector-owned host-key pins,
disables forwarding, never learns host keys, and applies connect,
authentication, execution, cancellation, and output limits.

SSH `exec` carries one command string, and an OpenSSH server normally passes
that string to the account's login shell with `-c`. The Connector therefore
does not claim to bypass the remote shell. It never starts a local shell and
never concatenates unquoted caller data into command syntax. Instead, after
policy validation has produced a structured executable plus argument vector,
it serializes every token independently with deterministic POSIX single-quote
encoding (including fixed tokens). Shell metacharacters, whitespace,
substitutions, and newlines in an allowed argument remain data in one remote
argument. Targets whose remote account does not provide POSIX-compatible
command parsing are unavailable in the initial release; a future remote helper
protocol would be required for literal `execve` semantics.

This is preferable to OpenSSH plus a password helper, which cannot meet the
no-leak requirement consistently across the three OSes.

### Funny authorizes; Connector verifies local and signed authority

Funny authorizes the human actor, project/thread access, target visibility, and
assigned runner. It signs the exact request. For production targets it issues a
short-lived, single-use confirmation bound to actor, thread/project, runner,
target, operation, and validated arguments. The Connector verifies the local
runtime caller, signature, expiry, request digest, and replay protection before
credential resolution.

An agent can propose a named operation but cannot create a target, enrol a
credential, forge a request, or create/reuse production confirmation.

### Native credential providers behind one Connector contract

After enrolment, a target stores only an opaque credential reference. The
Connector resolves that reference into memory for a single authentication and
clears it after success, failure, or cancellation. Providers must never reveal
secrets via command line, environment, stdout/stderr, IPC, or agent-readable
files. Unsafe native setups are disabled rather than downgraded.

The initial implementation exposes one Connector-owned provider contract backed
by Windows Credential Manager/DPAPI, macOS Keychain, or Linux Secret Service.
Keychain interaction is explicitly disabled during provider operations, and
Secret Service operations refuse locked collections with prompts disabled. If
a store cannot be accessed non-interactively by the Connector service account,
that Connector reports the provider unavailable; Vault Agent-compatible support
is a future alternative.

### Metadata-only observability

Funny and the Connector record correlation ID, actor, project/thread, runner,
target ID, operation ID, request digest, pairing/key version, decisions,
timestamps, and terminal status. They exclude passwords, credential references,
hostnames, raw command argv, credential envelopes, and unredacted output.
Remote output is size-capped, redacted by the Connector, and labelled untrusted.

## Risks / Trade-offs

- **An authorized operation can be destructive** → use least-privilege remote
  accounts, finite operation sets, and explicit production confirmation.
- **A privileged local attacker can compromise the Connector** → isolate its
  service account, use OS hardening, rotate credentials, and prefer SSH
  certificates where possible.
- **Browser encryption does not defeat a compromised web origin** → state the
  threat boundary clearly and offer signed local enrolment in a later phase.
- **A native store may not work non-interactively** → report it unavailable and
  do not fall back to an agent session or prompt.
- **Host-key rotation can interrupt work** → require an explicit signed overlap
  configuration and document the rotation runbook.
- **An embedded SSH library increases maintenance** → select one only after
  cross-platform authentication, host verification, cancellation, and security
  review; retain a provider abstraction for migration to certificates.
- **A separate product can drift from Funny's server/runtime** → negotiate a
  versioned protocol, publish a compatibility matrix, test supported version
  pairs, and fail closed on incompatibility.
- **Installers and upgrades expand the supply-chain surface** → produce
  reproducible where feasible, signed/checksummed artifacts with provenance;
  preserve service identity and credentials during atomic upgrades.

## Migration Plan

1. Add `packages/remote-connector`, the shared versioned protocol, platform
   build/install artifacts, pairing, target/operation management, enrolment
   relay, authorization, and audit model disabled until a healthy compatible
   Connector is paired.
2. Install and pair it on a non-production runner for each supported OS;
   configure a least-privilege remote account, target, host-key pins, and named
   operation, then enrol its password through the Funny UI.
3. Verify agent isolation, pairing/key binding, no-secret storage/logging,
   host verification, denied arbitrary commands, and failure modes.
4. Enable non-production operations, then production targets after approval and
   audit review. Rotate credentials or Connector keys through the same flow.
5. Migrate eligible targets to certificates and delete their password entries.

Rollback disables a target or unpairs the Connector. No credential is copied to
Funny; the local provider entry can be deleted or rotated independently.

## Open Questions

- Which Windows architectures and Linux package formats join x64 Windows,
  Apple Silicon/macOS, and x64 glibc Linux in the first release matrix?
- Which signing identities and release channel will Funny use for Windows code
  signing, macOS signing/notarization, and Linux package provenance?
- Which initial operation templates and typed argument shapes are safe enough
  for the first release?
- Is the initial scope per-user runners only, or do shared runners need
  additional target visibility and approval roles?
- Does the first release need signed local enrolment, or is the documented
  browser-enrolment threat boundary acceptable?
