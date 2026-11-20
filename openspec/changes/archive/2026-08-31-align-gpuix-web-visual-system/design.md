## Context

See `proposal.md` for motivation. The React client already has the visual reference components, CSS-variable themes, and stories for the thread experience. The GPUIX client has equivalent domain state and commands but currently composes them with inline styles and a small native-only `@funny/gpuix-ui` package containing buttons, fields, cards, badges, navigation items, select, separator, tooltip, and theme primitives.

The renderers cannot share JSX: the web client depends on DOM elements, Tailwind, Radix, TipTap, and browser behavior, while GPUIX uses native host elements, native event payloads, `virtual-list`, `markdown`, `code`, `diff`, and SVG. The existing native-client design also explicitly forbids DOM emulation and wholesale recreation of Dockview. Visual parity must therefore come from shared semantics and fixtures, not a shared component runtime.

## Goals / Non-Goals

**Goals:**

- Make the supported native thread shell recognizably equivalent to the React reference in hierarchy, density, color roles, component states, and responsive behavior.
- Keep presentation components composable and independent of Funny stores, network services, and domain commands.
- Establish deterministic evidence that detects renderer drift without claiming unavailable native presentation telemetry.
- Preserve virtual-list row stability and the current native command/state contracts during the visual migration.

**Non-Goals:**

- Pixel-identical text rasterization, scrollbar rendering, or font metrics across operating systems and renderers.
- Sharing React DOM component implementations with GPUIX or introducing fake DOM APIs.
- Porting Dockview, TipTap, terminal, browser, Monaco, settings, plugin visualizers, or the full web shell.
- Adding unsupported product actions merely to reproduce icons visible in the React header.
- Replacing all existing React themes in one migration.

## Decisions

### 1. Add a dependency-free visual-contract package

Create `@funny/ui-contracts` as a small TypeScript package with no React, DOM, GPUIX, or product-store dependencies. It owns:

- semantic theme and density types;
- the initial named `reference-dark` parity token set;
- layout metrics such as sidebar baseline width, compact breakpoint, conversation maximum width, composer width, control sizes, spacing, and radii;
- serializable component-state fixture types and the supported parity inventory.

Colors use a normalized renderer-neutral representation and dimensions use logical pixels. The web adapter exposes them through CSS variables or resolved style values; the GPUIX adapter translates them to native `StyleDesc` values. Additional web themes remain supported but are outside paired acceptance until they receive a named shared token set.

Putting these contracts in `@funny/shared` was rejected because visual semantics are not domain data. Making the web client depend on `@funny/gpuix-ui` was rejected because it would pull native renderer concerns across the platform boundary.

### 2. Keep renderer implementations separate but align their public anatomy

The existing React components remain the behavioral reference. `@funny/gpuix-ui` gains native components with equivalent presentational anatomy:

```text
AppShell
├── Sidebar
│   ├── SidebarSection
│   ├── ProjectGroup
│   └── ThreadListItem
└── ThreadPane
    ├── ThreadHeader
    ├── ConversationViewport
    │   ├── UserMessageCard
    │   ├── AssistantMessage
    │   ├── ToolCallCard
    │   └── StatusCard / TodoCard / PermissionCard
    └── PromptComposer
        ├── PromptEditorSurface
        ├── ComposerContext
        └── ComposerActions
```

Components accept primitive presentational props, event callbacks, and children. They do not import Funny stores or transport services. Compound components are used where consumers need to control anatomy, while variants describe mutually exclusive visual states such as severity, selected state, message role, and composer lifecycle.

Copying the full product-aware web components was rejected because their DOM behavior and broad dependencies would recreate renderer coupling inside the library.

### 3. Treat the centered content column as the primary parity anchor

The conversation viewport and composer share a bounded content-width token corresponding to the React `max-w-3xl` reference. User messages render as bounded inverse-surface cards; assistant messages render directly on the conversation canvas; tool and status content render as nested bounded cards. Raw role labels and alternating full-width message backgrounds are removed from normal product mode.

The header uses compact control-height tokens and the sidebar uses the same density scale as its section and thread rows. These structural anchors produce more perceived parity than attempting to tune individual colors while retaining the current full-width GPUIX layout.

An exact-pixel screenshot clone was rejected because native font metrics and rendering differ. Acceptance compares semantic roles and documented layout tolerances instead.

### 4. Adapt domain state at the application boundary

`client-gpuix` maps its navigation, workspace, run, permission, and realtime state into presentational props immediately before component composition. Existing actions remain owned by the application service. The web client maps its existing component states into the same fixture vocabulary only for parity tests and reference stories; it does not replace production stores.

This preserves stable virtual-list keys and memoization. Presentational components receive immutable row-level props so an unrelated workspace update does not rerender every message or thread item.

A shared cross-renderer UI store was rejected because it would mix presentation preferences with already-shared domain state and expand the migration beyond visual parity.

### 5. Provide a bounded renderer-independent icon vocabulary

The visual contract defines semantic icon names required by the supported thread shell, such as navigation toggle, back, project, branch, activity, attachment, send, stop, overflow, expand, and collapse. React continues to render its existing Lucide icons. `@funny/gpuix-ui/icon` renders equivalent SVG geometry through the native `<svg>` host and `IconButton` composes focus, hover, disabled, label, and tooltip behavior.

Only icons connected to supported native actions are shown. Unsupported actions are omitted rather than displayed inertly.

Using text glyphs as icons was rejected because their shape varies by font and platform. Adding another native icon runtime is unnecessary while GPUIX supports SVG.

### 6. Build interactive overlays only where the native primitive is reliable

Composer model/mode selection uses the existing GPUIX select primitive, and labeled icon actions use the existing tooltip primitive. Simple anchored overflow menus may be added when required by a supported action. Complex web dropdown submenus, dialogs, and rich editor suggestions remain renderer-specific and out of scope unless a parity requirement needs them.

This avoids building a general overlay framework before the high-impact static hierarchy is aligned.

### 7. Separate diagnostics from product composition

Host warnings, frame counters, rich-rendering switches, and logout/debug actions move behind an explicit diagnostic/development surface that overlays or replaces a dedicated area without contributing to the product fixture's layout measurements. Normal native product mode uses the same compact header hierarchy as the web reference.

Hiding diagnostic information entirely was rejected because it remains important while GPUIX is experimental; the separation is visual and operational, not removal.

### 8. Validate semantics first and screenshots where supported

Each parity fixture is renderer-neutral data describing viewport class, named theme, navigation rows, messages, composer lifecycle, and status surfaces. Both renderers provide fixture hosts and assert:

- visible text and semantic component role;
- state and action availability;
- selected, focused, disabled, pending, and resolved variants;
- application of key shared layout and theme tokens;
- stable row identity for virtualized native content.

On supported hosts, paired images cover representative desktop and compact fixtures. Image comparison uses documented tolerances for bounding geometry and color while excluding text antialiasing, native scrollbars, and diagnostic overlays. Missing native capture is recorded as unsupported and never replaced with timing or mutation evidence.

When the project has no macOS or Windows host, completion uses the strongest available Linux evidence: a production GPUIX bundle, authenticated workflow integration suites, paired structural fixtures, and an explicit host-capability record. This closes implementation acceptance without claiming that interactive native rendering or pixel parity was observed. A future supported-host run remains useful follow-up evidence, but is not a prerequisite the project cannot execute.

DOM snapshots alone were rejected because they cannot detect the large geometry differences visible today. Screenshot-only gates were also rejected because native capture is not reliable on every development host.

## Risks / Trade-offs

- **[Shared tokens drift from existing CSS themes]** → Make `reference-dark` the explicit paired baseline, test its adapter values, and add other named themes incrementally.
- **[Native font metrics prevent exact wrapping parity]** → Compare hierarchy and bounded geometry with wrapping tolerances; do not require identical line breaks.
- **[New components regress native long-thread performance]** → Preserve virtual-list boundaries, stable keys, row memoization, and rerender regression tests before integrating decorative elements.
- **[The contract package becomes a second design system implementation]** → Limit it to serializable semantics, tokens, icon names, and fixtures; renderer behavior stays in renderer packages.
- **[Unsupported native actions make the header appear sparse]** → Render only supported actions in consistent slots and preserve alignment without inert controls.
- **[Diagnostics become harder to discover]** → Keep an explicit launch flag or development entry and document it in the native-client workflow.
- **[Visual changes accidentally alter domain behavior]** → Migrate one shell region at a time and run existing auth, navigation, realtime, prompt, permission, and long-history tests after each region.

## Migration Plan

1. Add the renderer-neutral contracts, `reference-dark` tokens, fixture schema, and adapter tests without changing production composition.
2. Extend `@funny/gpuix-ui` with icon, layout, conversation, composer, navigation, and status components plus state-focused tests.
3. Migrate the GPUIX conversation column, user/assistant messages, composer, and compact header first; retain existing application services and rollback by restoring the old composition.
4. Migrate sidebar grouping, project/thread rows, status pins, metadata chips, and supported row actions.
5. Migrate tool, todo, permission, connection, loading, empty, and error surfaces.
6. Move diagnostics out of product composition and add paired desktop and compact fixture evidence.
7. Run repository gates, GPUIX production build, available native smoke coverage, functional parity tests, and controlled renderer profiling. When no supported interactive host exists, retain the recorded capability limitation and use automated authenticated workflow coverage for acceptance. Keep GPUIX explicitly experimental regardless of visual completion.

Rollback does not require data migration: the web client remains the default, and the native composition can revert to the existing components without changing stores, persisted session material, routes, or server data.
