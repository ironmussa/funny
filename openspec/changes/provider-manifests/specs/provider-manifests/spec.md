## ADDED Requirements

### Requirement: ACP providers are defined by declarative manifests

The system SHALL define each ACP-based agent provider as a declarative `ProviderManifest` (pure data: spawn command/args/env, model-select method, permission-mode map, fork-capability paths, builtin tools, model-discovery strategy, auth mode, and quirk flags) consumed by a single generic ACP runtime. The system SHALL NOT require a bespoke per-provider process class for an ACP provider whose behavior is fully expressed by a manifest.

#### Scenario: Adding an ACP provider requires only a manifest

- **WHEN** a developer adds a new ACP provider whose behavior is covered by the existing quirk-flag menu
- **THEN** they author one `ProviderManifest` and register it, with no edits to the generic ACP process, the type union, the model registry, the zod schema, the fork allow-list, or the client picker beyond what the manifest registry derives automatically

#### Scenario: Existing providers preserve behavior under the generic runtime

- **WHEN** codex, gemini, pi, cursor, and opencode are migrated to manifests run by `GenericACPProcess`
- **THEN** each provider's existing ACP adapter test suite passes unchanged, and a thread runs end-to-end with the same message/tool/permission behavior as before

### Requirement: Provider-specific behavior is a fixed in-core menu, not manifest code

The system SHALL express provider-specific `translateUpdate` divergences as named quirk flags selected by the manifest, whose behaviors are implemented in core. A manifest SHALL NOT carry executable code.

#### Scenario: A manifest selects a vetted behavior

- **WHEN** a manifest sets a quirk flag (e.g. buffer preamble tool_calls into a Think card)
- **THEN** the generic runtime applies the corresponding in-core behavior for that provider

#### Scenario: A behavior outside the menu requires a core change

- **WHEN** a provider needs a `translateUpdate` behavior not present in the quirk menu
- **THEN** adding it is a reviewed core change that extends the menu — it cannot be introduced by a manifest alone

### Requirement: All provider-dependent layers derive from the manifest registry

The system SHALL derive the agent-provider registry, model-registry entries, provider labels/defaults/attachment limits, the validation schema's provider set, the ACP fork allow-list and capability paths, model discovery, provider detection, and the client model-picker groups from the manifest set rather than per-provider hardcoding.

#### Scenario: A single source of truth

- **WHEN** the manifest registry gains or loses a provider
- **THEN** the type registry, model catalog, validation, fork handling, discovery, and client picker reflect the change without per-layer manual edits

#### Scenario: Unknown provider ids are accepted at the boundary

- **WHEN** a provider id that is not in the compile-time known set is submitted
- **THEN** validation accepts it as a string and resolution falls back through the runtime registry (no compile-time union blocks an unbundled provider)

### Requirement: External provider extensions are declarative-only (design constraint)

The system's external provider-extension mechanism (future phase) SHALL accept only declarative JSON manifests discovered from disk, mirroring the visualizer-extension loader's guardrails. It SHALL NOT load executable provider/harness code into the runner. Installing such a manifest SHALL disclose the binary it will launch.

#### Scenario: A declarative manifest is loadable

- **WHEN** an external `funny.provider` JSON manifest declares an already-installed binary and ACP protocol params using only quirk flags from the in-core menu
- **THEN** the runner can register it as a provider without executing any third-party code

#### Scenario: Executable-code harnesses are rejected in this scope

- **WHEN** an extension attempts to supply executable transform code or a custom non-ACP protocol
- **THEN** it is out of scope for this capability and not loaded (deferred to a future sandboxed mechanism)
