## 1. Lifecycle Correctness

- [x] 1.1 Add a regression test proving that moving focus between native child controls does not mark the application lifecycle inactive.
- [x] 1.2 Remove application lifecycle updates from the GPUIX root element's child focus and blur handlers while preserving intentional control focus behavior.
- [x] 1.3 Keep the conservative native lifecycle active during the 0.5.1 window lifetime and verify that stop and termination still publish `focused: false` and `visible: false`.
- [x] 1.4 Document or expose diagnostic evidence that GPUIX 0.5.1 does not provide a verified independent window-focus signal.

## 2. Expandable Native Diffs

- [x] 2.1 Add native component coverage for a diff below the initial limit and a truncated diff that exposes its expansion action.
- [x] 2.2 Track per-message expansion state and connect the native diff `onShowMore` callback while retaining the 120-line initial cap.
- [x] 2.3 Verify expansion renders the remaining diff without losing surrounding message state or destabilizing message-row memoization.

## 3. Deterministic Visual Capture

- [x] 3.1 Extract and unit-test a bounded readiness probe that requires the expected visual-parity fixture marker to be stable across consecutive renderer observations.
- [x] 3.2 Replace the capture script's fixed-delay-only readiness with the probe, an actionable timeout failure, and cleanup that always stops the loop and unmounts the root.
- [x] 3.3 Preserve explicit unsupported-host evidence and verify that timeout paths do not publish a successful screenshot record.

## 4. Diagnostic Overlay Policy

- [x] 4.1 Update frame-diagnostics tests for hidden-by-default, explicitly enabled, and statistics-reset behavior.
- [x] 4.2 Make the standard native entry point pass its diagnostics option to the overlay policy so ordinary launches remain unobscured.
- [x] 4.3 Verify the product benchmark continues enabling native frame statistics independently of the standard-client default.

## 5. Renderer Failure Surface

- [x] 5.1 Add renderer error-boundary coverage for explicit high-contrast surface, heading, detail, and recovery-instruction styling.
- [x] 5.2 Apply a self-contained crash palette that remains readable without relying on the application's theme provider.

## 6. Supported-Host Verification

- [x] 6.1 Add explicit `gpuix-ui` typecheck and test steps to the existing Linux, macOS, and Windows GPUIX CI matrix.
- [x] 6.2 Verify native renderer tests fail normally when available on macOS and Windows and report explicit unsupported skips on hosts without the native renderer.
- [x] 6.3 Update GPUIX client/readiness documentation with the new CI gate, conservative 0.5.1 lifecycle limitation, and opt-in overlay behavior.

## 7. Final Validation

- [x] 7.1 Run focused `gpuix-ui`, `client-gpuix`, and visual-capture helper tests, including all portable fallbacks on the current host.
- [x] 7.2 Run `bun run --cwd packages/client-gpuix build` and any affected packaging or smoke checks supported by the current host.
- [x] 7.3 Run the repository-required `bun run typecheck` and `bun run lint`, and record any pre-existing warnings separately from regressions.
- [x] 7.4 Run `openspec validate harden-gpuix-client-runtime --strict` and confirm every scenario has corresponding automated or explicitly host-gated evidence.
