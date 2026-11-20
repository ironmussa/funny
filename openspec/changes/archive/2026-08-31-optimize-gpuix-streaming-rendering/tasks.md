## 1. Lightweight Streaming Rows

- [x] 1.1 Add portable coverage for Rich/Fast selection across streaming and durable message delivery.
- [x] 1.2 Render assistant streaming previews as plain text and restore rich Markdown/diff presentation after durable reconciliation.

## 2. Isolated Thread Composition

- [x] 2.1 Replace broad header, composer, and permission subscriptions with primitive or stable-reference selectors.
- [x] 2.2 Split and memoize selected-thread header, content, controls, and permission boundaries so message-only updates do not reconcile stable siblings.
- [x] 2.3 Add render/reference regression coverage proving streaming isolation while run, access, and permission changes remain reactive.

## 3. Diagnostic Controls

- [x] 3.1 Add a tested frame-statistics reset helper and inject its action from the native renderer owner.
- [x] 3.2 Relabel the mode control as `Rendering: Rich/Fast`, add diagnostic-only `Reset stats`, and cover visibility/actions.

## 4. Evidence and Verification

- [x] 4.1 Update native diagnostics/performance documentation for lightweight streaming and reset behavior.
- [x] 4.2 Run focused tests, build, and the populated-project renderer smoke benchmark.
- [x] 4.3 Run React Doctor, repository lint/typecheck, and strict OpenSpec validation.
