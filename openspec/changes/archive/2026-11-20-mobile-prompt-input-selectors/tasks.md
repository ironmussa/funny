## 1. Shared mobile presentation

- [x] 1.1 Add the Radix-compatible shadcn Drawer primitive and required dependency; verify installation resolves and the primitive imports successfully in the client.
- [x] 1.2 Create the shared prompt selection shell with title, selection indication, 48px touch targets, close control, safe-area padding, bounded scrolling, focus restoration, and no automatic search focus; verify component tests cover opening, dismissal, and accessible naming.
- [x] 1.3 Integrate the existing mobile breakpoint and discard transient choices when crossing it; verify tests at 767px and 768px and resizing with a pending choice.

## 2. Prompt selector integration

- [x] 2.1 Adapt prompt mode and template selectors to mobile panels while preserving options, groups, disabled states, and no-template behavior; verify selection invokes existing callbacks once, closes, and cancellation preserves values.
- [x] 2.2 Adapt model selection with provider groups and an internal effort step with Back navigation; verify completion, cancellation, Back, disabled models, models without effort, and permitted provider setup actions.
- [x] 2.3 Add explicit mobile presentation opt-in to the shared branch picker and enable it only for prompt branch context call sites; verify filtering, loading/empty states, special branch actions, selection callbacks, and unchanged settings presentation.
- [x] 2.4 Update branch virtualization measurements for mobile row heights; verify a long list scrolls to its final option without overlap or inaccessible rows.
- [x] 2.5 Add English and Spanish panel/navigation labels and accommodate larger triggers in the mobile prompt toolbar; verify both locales and a narrow viewport show readable labels without horizontal overflow.

## 3. Integrated verification

- [x] 3.1 Add or update focused regression tests across all four selector families, including desktop presentation and prompt contexts inside dialogs; verify the relevant client unit suite passes.
- [x] 3.2 Verify in a browser at narrow mobile, 767px, 768px, and desktop widths: touch scrolling, swipe/outside/Close dismissal, focus restoration, software keyboard handling, safe-area layout, and model-to-effort navigation; record results and any device-specific verification limits.
- [x] 3.3 Run the React Doctor workflow required for React changes plus `bun run lint` and `bun run typecheck`; resolve introduced failures and record unrelated existing failures separately.

Verification results and physical-device limits: see [verification.md](verification.md).
