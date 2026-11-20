## Context

See [proposal.md](proposal.md) for motivation. `@funny/client` is currently both the React DOM application and the owner of state, API, and realtime behavior. Browser dependencies are concentrated in components and hooks, but several stores and transport modules also read `window`, `document`, `localStorage`, routing state, or web notification APIs directly. The package compiles with DOM libraries and is a private leaf application, so importing it from a future renderer would also pull in assumptions unrelated to the shared behavior.

The migration must preserve the existing web and Tauri application while changes land incrementally. It must also preserve remote-container origin validation and avoid making a hypothetical GPUIX implementation a build dependency.

## Goals / Non-Goals

**Goals:**

- Establish a package boundary whose runtime modules compile without DOM libraries, React DOM, Vite globals, or renderer packages.
- Make host dependencies explicit and independently testable.
- Preserve current public store/API imports in the web client during migration through compatibility exports.
- Separate typed event interpretation and state transitions from Socket.IO wiring and presentation effects.
- Enforce the boundary continuously after the migration.

**Non-Goals:**

- Port React components or DOM hooks to GPUIX.
- Add GPUIX, replace Tauri, or ship a second client executable.
- Abstract inherently visual facilities such as layout measurement, observers, selection, drag-and-drop, Monaco, terminal rendering, or CSS theme application.
- Move server-domain types out of `@funny/shared` or redesign the server protocol.
- Migrate every client store solely because it uses Zustand; only behavior needed across renderers belongs in the new boundary.

## Decisions

### 1. Add `@funny/client-core` as the renderer-independent package

Create `packages/client-core` with an ES2023 TypeScript configuration that omits DOM libraries. It may depend on `@funny/shared` and small runtime-neutral libraries, but not on `@funny/client`, React DOM, browser-only libraries, Tauri APIs, or Vite environment globals.

The package will own the platform contracts, transport resolution rules, pure event-processing helpers, selectors/state transitions moved out of web hooks, and store factories that are genuinely useful to more than one renderer. `@funny/client` remains the web/Tauri application and supplies the concrete host implementation.

This is preferred over a `src/platform` folder inside `@funny/client` because TypeScript path aliases and convention alone would not prevent the supposedly reusable code from acquiring DOM dependencies, and another client should not import a private Vite leaf app. Adding the contracts to `@funny/shared` was rejected because they describe client runtime capabilities rather than protocol/domain data used by the server.

### 2. Use segregated service interfaces composed into one platform value

Define narrow capabilities and compose them into a `ClientPlatform` value:

```text
ClientPlatform
├── storage       read · write · remove · subscribe
├── navigation    current location · subscribe
├── transport     API/Socket endpoint resolution · fetch-like request
├── lifecycle     current focus/visibility · subscribe
└── effects       semantic notification/toast/application-event sink
```

Capabilities required by a module are passed explicitly to its factory; modules should accept the narrow subset they use rather than importing a global platform singleton. The application composition root creates one web platform value and wires the API client, realtime controller, and migrated stores before rendering.

A React context was rejected as the primary injection mechanism because stores, API clients, and event dispatchers execute outside React. A mutable module-global service locator was rejected because import order would remain significant and tests could leak platform state. React bindings may consume already-created stores/controllers, but they do not own platform construction.

### 3. Keep store instances at renderer edges and move reusable factories inward

Where a Zustand store contains reusable behavior, `@funny/client-core` will export a vanilla store factory or pure state/action factory. The web package will instantiate it with web services and retain compatibility hooks/exports so components can migrate without a flag day. Renderer-only state stays in `@funny/client` even if it uses local persistence.

Migration eligibility is behavioral, not based on folder name. Thread state mutations, read markers, portable preferences, and transport health are candidates. Panel dimensions, DOM node references, CSS mutations, browser layout, and terminal renderer state remain web-specific. Mixed stores are split so a renderer-independent state core does not depend on renderer effects.

This is preferred over wrapping every existing store method with a platform object because that would preserve oversized mixed stores and expose web-only state as a false cross-renderer contract.

### 4. Separate endpoint policy, transport wiring, event transitions, and effects

Transport will be layered as follows:

```text
web/Tauri environment + Socket.IO/fetch wiring
                    │
                    ▼
       typed events and endpoint policy
                    │
                    ▼
       state action ports + semantic effects
```

`@funny/client-core` owns deterministic endpoint policy, including browser/Tauri mode inputs and remote-container validation, but does not read `window` or `import.meta.env`. The web adapter converts current environment values into explicit configuration. It also owns Socket.IO construction and DOM lifecycle listeners.

Realtime dispatch will depend on action ports for the stores it updates and an effect sink for presentation. Existing React hooks become lifecycle wrappers around a renderer-neutral controller. Notification text or other domain-relevant effect payloads may be produced by the core; Sonner calls, `Notification`, `CustomEvent`, window focus, and preview-window behavior stay in the web adapter.

Keeping Socket.IO itself in the core was rejected because a future native host may use a different transport implementation. Reducing the separation to endpoint URLs alone was rejected because direct toast, event, and store imports in dispatch would still prevent reuse.

### 5. Preserve compatibility with a web platform adapter and contract tests

The web adapter will reproduce current semantics for:

- existing local-storage keys and default/corrupt-value behavior;
- regular-browser same-origin `/api` and page-origin realtime connections;
- Tauri localhost server-port connections;
- allowed remote-container origin validation;
- route parsing and focus/visibility resync gating;
- notifications, toasts, and application custom events.

Core contract tests run with deterministic in-memory services and no jsdom. Web adapter tests run under the existing client test environment and assert parity at the platform boundary. Existing feature tests remain as regression coverage.

No persisted data migration is planned. Compatibility adapters keep current exports until all web callers use the new instances; their removal would be a separate cleanup change.

### 6. Enforce the dependency direction with a fitness rule

Extend the repository layering validation to check `packages/client-core/src` and any explicitly designated renderer-independent client directories. The rule rejects imports from `@funny/client`, React renderer packages, browser-only dependencies, Tauri/Vite APIs, and direct references to browser/DOM globals and types. Tests and adapter directories are scoped separately so mocks and concrete web implementations remain possible.

The package's DOM-free `tsconfig` provides a second line of defense. Using lint rules alone was rejected because import and global restrictions must also apply in CI through the repository's existing architecture-fitness workflow and report the architectural boundary explicitly.

## Risks / Trade-offs

- **[Risk] The platform object becomes a grab bag of unrelated host APIs.** → Keep capability interfaces segregated, pass only required subsets, and require a concrete cross-renderer use case before adding a capability.
- **[Risk] Moving whole stores creates a large migration and merge conflicts with active client work.** → Migrate by vertical slice, retain compatibility exports, and split mixed stores instead of bulk-moving the directory.
- **[Risk] Web behavior changes subtly during extraction.** → Capture storage keys, endpoint matrices, lifecycle throttling, remote-origin rejection, and semantic effects in parity tests before switching each slice.
- **[Risk] Event ports mirror every store and become cumbersome.** → Define ports around stable actions required by event processing, not entire store shapes; group closely related actions and keep renderer-only branches in the adapter.
- **[Risk] A future GPUIX client needs capabilities not represented here.** → Treat the contract as extensible and prove only a DOM-free in-memory host in this change; do not speculate about GPUIX rendering APIs.
- **[Trade-off] A new workspace package adds configuration and public surface area.** → The stronger compiler/package boundary is worth the small setup cost and avoids coupling another renderer to the Vite client.

## Migration Plan

1. Add the DOM-free package, capability contracts, in-memory test services, and fitness rule without changing production wiring.
2. Implement and parity-test the web/Tauri platform adapter at the existing client composition root.
3. Extract storage-backed portable state behind store factories while retaining current web exports and storage keys.
4. Extract endpoint policy and API client construction, then switch existing API modules to the configured web client.
5. Split realtime processing into typed transitions/action ports and semantic effects; keep Socket.IO and DOM lifecycle listeners in the web adapter.
6. Audit the designated core boundary, run repository gates, and document which modules are portable versus intentionally web-only.

Each vertical slice can be rolled back by restoring its previous web export/wiring; no schema or persisted-data rollback is required. The compatibility layer is removed only in a future change after consumers have migrated.
