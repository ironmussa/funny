## 1. Visual Contract Foundation

- [x] 1.1 Scaffold the dependency-free `@funny/ui-contracts` workspace package with public subpath exports and include it in repository typecheck and architecture gates.
- [x] 1.2 Define renderer-neutral semantic color, typography, spacing, radius, control-size, content-width, breakpoint, and density types.
- [x] 1.3 Encode the named `reference-dark` token set from the React reference theme and add exact-value contract tests.
- [x] 1.4 Define serializable parity fixture types for viewport, navigation, conversation, composer, activity cards, focus, and lifecycle states.
- [x] 1.5 Publish the supported component-state parity inventory and validate that fixture identifiers and required states are unique and complete.
- [x] 1.6 Add web and GPUIX token adapters with tests proving that corresponding semantic roles resolve from the same contract values.

## 2. GPUIX Visual Primitives

- [x] 2.1 Replace the standalone GPUIX dark-theme constants with an adapter over `reference-dark` while preserving theme overrides.
- [x] 2.2 Add a bounded semantic `Icon` vocabulary rendered through native SVG and test every supported icon name.
- [x] 2.3 Extend `IconButton` to cover labeled focus, hover, selected, disabled, destructive, and tooltip states.
- [x] 2.4 Add reusable centered-content, surface, stack, inline, and responsive shell primitives backed by shared layout tokens.
- [x] 2.5 Add focus and keyboard-activation tests for the new interactive primitives on the available native renderer or test host.
- [x] 2.6 Update `@funny/gpuix-ui` package exports and usage documentation for all new primitives.

## 3. Conversation Presentation

- [x] 3.1 Implement `ConversationViewport` with the shared maximum content width, desktop and compact padding, bottom alignment, and virtual-list compatibility.
- [x] 3.2 Implement `UserMessageCard` with inverse-surface styling, bounded expansion, attachments fallback, metadata slots, and keyboard focus behavior.
- [x] 3.3 Implement `AssistantMessage` with transparent canvas presentation and shared Markdown, code, table, and diff spacing roles.
- [x] 3.4 Implement reusable `ToolCallCard`, `TodoCard`, `StatusCard`, and `PermissionCard` state variants.
- [x] 3.5 Adapt native message and tool-call state into the new presentational props without moving commands or domain state into the UI package.
- [x] 3.6 Replace full-width native role bands with the centered conversation composition while retaining stable render-item keys, pagination, follow-tail, and content fallbacks.
- [x] 3.7 Add component tests for user, assistant, rich-content, collapsed, unsupported-content, tool, todo, permission, connection, loading, empty, and error fixtures.
- [x] 3.8 Extend the message-row memoization regression tests to prove unrelated workspace updates do not rerender unchanged visual rows.

## 4. Thread Header and Prompt Composer

- [x] 4.1 Implement a compact `ThreadHeader` with title, contextual metadata, navigation slot, supported action slots, and responsive variants.
- [x] 4.2 Implement compound `PromptComposer`, `PromptEditorSurface`, `ComposerContext`, and `ComposerActions` components aligned to the conversation column.
- [x] 4.3 Compose the existing GPUIX select and tooltip primitives into model, mode, send, stop, and supported attachment controls.
- [x] 4.4 Add idle, pending, running, waiting, read-only, disabled, and error variants without duplicating application command logic.
- [x] 4.5 Integrate the compact header and composer into `client-gpuix` and remove the oversized header and separate full-width control bar from normal product mode.
- [x] 4.6 Add responsive and interaction tests for desktop, compact, submit, resume, stop, read-only, and focus-visible composer states.

## 5. Sidebar and Navigation Parity

- [x] 5.1 Implement `SidebarSection` and its heading, count, collapse, and view-all slots using shared density tokens.
- [x] 5.2 Implement `ProjectGroup` with color, expansion, optional branch or count metadata, and keyboard activation.
- [x] 5.3 Implement `ThreadListItem` with selected, running, completed, waiting, failed, and setting-up variants.
- [x] 5.4 Implement reusable `StatusPin` and `MetaChip` components for activity, time, branch, model, and change-count metadata.
- [x] 5.5 Adapt native navigation state into the section, project, and thread-row props while omitting unavailable metadata without placeholders.
- [x] 5.6 Replace the basic native navigation rows and group headings with the new sidebar composition while preserving access and selection behavior.
- [x] 5.7 Add keyboard, focus, selection, grouping, long-title, missing-metadata, and responsive sidebar tests.

## 6. Product and Diagnostic Separation

- [x] 6.1 Define an explicit native diagnostic-mode input or launch option that is unavailable accidentally in normal product composition.
- [x] 6.2 Move package warnings, host support notices, rendering switches, frame counters, and debug session actions into a dedicated diagnostic surface.
- [x] 6.3 Ensure diagnostic presentation does not change product fixture geometry and add normal-versus-diagnostic structural tests.
- [x] 6.4 Present realtime interruption as a reusable non-destructive status surface that preserves visible durable conversation content.

## 7. Paired Parity Fixtures and Evidence

- [x] 7.1 Add shared desktop and compact fixtures covering grouped navigation, a user/assistant exchange, Markdown, tool output, todo state, permission state, and idle or running composer states.
- [x] 7.2 Add a deterministic React reference fixture host that renders the shared fixture data with `reference-dark`.
- [x] 7.3 Add a deterministic GPUIX fixture host that renders the same data without application stores, networking, or diagnostics.
- [x] 7.4 Add paired structural assertions for visible content, semantic roles, action availability, state variants, token use, and key geometry.
- [x] 7.5 Add supported-host image capture with documented exclusions and tolerances for geometry, spacing, and color comparison.
- [x] 7.6 Record native image capture as unsupported when unavailable and keep structural parity results distinct from visual evidence.
- [x] 7.7 Perform a keyboard and accessibility review of the paired header, navigation, message, activity, and composer fixtures and add regressions for discovered gaps.

## 8. Integration, Performance, and Repository Gates

- [x] 8.1 Run the existing native auth, navigation, realtime, prompt, permission, recovery, responsive-layout, and workflow smoke suites after the visual integration.
- [x] 8.2 Validate navigation, streaming, submit, stop or resume, and permission decisions through the authenticated workflow suites and GPUIX production build; record interactive native rendering as unverified because the project has no macOS or Windows host.
- [x] 8.3 Re-run long-thread and repeated-navigation profiling and document any CPU, RSS, retained-growth, or row-rerender regression from the visual components.
- [x] 8.4 Update the GPUIX UI and native-client documentation with component anatomy, token ownership, supported parity scope, diagnostics access, and known renderer differences.
- [x] 8.5 Run focused package tests, `bun run lint`, `bun run typecheck`, the relevant production builds, and React diagnostics; resolve all new failures before completion.
- [x] 8.6 Validate the OpenSpec change strictly and record final paired parity evidence and any explicitly inconclusive host capabilities.
