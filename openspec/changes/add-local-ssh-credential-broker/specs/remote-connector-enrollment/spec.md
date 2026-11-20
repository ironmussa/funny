## ADDED Requirements

### Requirement: Connector pairing establishes a runner-bound encryption identity

The system SHALL pair a Funny Remote Connector with exactly one runner through
a human-verified, one-time pairing code. The Connector SHALL generate and retain
its private enrolment key under its isolated service identity and register only
its versioned public key, key fingerprint, capabilities, and pairing metadata
with Funny. Funny MUST NOT receive or persist the private key.

#### Scenario: Human pairs an eligible Connector

- **WHEN** a human verifies the Connector one-time pairing code in Funny
- **THEN** Funny binds the Connector public-key version to the selected runner
- **AND** credential enrolment becomes available only for that Connector

#### Scenario: Pairing code is invalid or expired

- **WHEN** pairing uses an invalid, expired, or already consumed code
- **THEN** Funny rejects the pairing
- **AND** it does not bind the Connector or accept enrolment for it

### Requirement: Credential enrolment is encrypted to the paired Connector

The system SHALL allow only a human with target-management permission to enrol,
replace, or delete a target credential. Before transmission, the Funny client
MUST encrypt an enrolment envelope to the paired Connector public key and bind
runner ID, Connector key version, target ID, credential version, and expiry as
authenticated data. Funny SHALL relay the opaque envelope only to the matching
online Connector and MUST NOT persist the envelope or plaintext credential.

#### Scenario: Human enrols a credential for a paired Connector

- **WHEN** an authorized human submits a credential for a target with a healthy Connector
- **THEN** the client sends only the encrypted envelope to Funny
- **AND** Funny relays it to the matching Connector and persists only non-secret status and version metadata

#### Scenario: Envelope binding is invalid

- **WHEN** a Connector receives an expired or mismatched runner, key version,
  target ID, or credential version
- **THEN** it rejects the envelope and does not persist the credential
- **AND** it returns only a non-secret enrolment failure status

### Requirement: Key and credential rotation invalidate obsolete enrolments

The system SHALL support Connector public-key and credential rotation without
exposing prior values. Key rotation MUST require new human-verified pairing and
invalidate pending envelopes for the old key. Credential rotation MUST atomically
replace or disable the prior local reference.

#### Scenario: Connector key is rotated

- **WHEN** a human completes pairing for a new Connector key version
- **THEN** Funny marks the previous key unavailable for new enrolments
- **AND** the Connector rejects envelopes addressed to that old key after its transition window

#### Scenario: Credential is deleted

- **WHEN** an authorized human deletes a target credential
- **THEN** the Connector deletes or disables its local provider entry
- **AND** later remote operations fail before SSH authentication
