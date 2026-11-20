## Implementation

Implemented the four prompt selector families below 768px with a shared shadcn/Vaul drawer. Desktop selectors retain their existing Radix implementations, extracted into `PromptSelectors.tsx`. Shared branch pickers opt in only from the prompt context bar. Mobile option/trigger heights use explicit 48px values because the application's rem scale makes `min-h-12` smaller than 48px.

## Automated verification

- Focused client suite: **44 tests passed in four files**, including 14 new selector tests and one prompt integration test.
- Coverage includes mode selection/dismissal/focus, template groups/clearing, staged effort/Back/cancel, unavailable providers, provider setup, breakpoint transitions, desktop presentation, branch search/creation, shared-picker isolation, and nested dialogs.
- `bun run lint`: passed (repository warnings remain).
- `bun run typecheck`: passed the repository baseline gate; zero client errors, two existing errors elsewhere below the baseline.
- React Doctor changed-scope comparison: **69/100 before and after**, no score regression. The working tree includes unrelated changes; this is not a clean whole-repository health claim.
- `git diff --check`: passed.

Command for the focused suite:

```bash
bun run --cwd packages/client test src/__tests__/components/mobile-prompt-selectors.test.tsx src/__tests__/components/PromptInputModelSelect.test.tsx src/__tests__/components/SearchablePicker.test.tsx src/__tests__/components/PromptInput.test.tsx
```

## Browser verification

Used the existing local client server with an intercepted test page importing the actual selector components and application stylesheet; no application records were changed and no additional development server was started.

- Chromium at 320, 390, and 767px: full-width mobile panel, actual option height at least 48px, same-panel model/effort completion, restored trigger focus, no horizontal document overflow.
- At 768 and 1280px: existing desktop model menu.
- Real virtualizer with 1,000 branches: last option reachable, 48px rows, selection callback, and search filtering.
- Search not autofocused on open; explicit Close and outside dismissal.
- Touch swipe dismissal via browser touch input.
- Focused search and close control reachable with reduced viewport height.
- Spanish template labels and groups visually inspected.
- Drawer opens/closes inside a parent prompt dialog while keeping the parent open.

Limitations: this browser check isolates the selectors rather than exercising a live thread end to end. Software keyboard behavior and device safe-area insets still need a physical iOS/Android check; reduced viewport simulation does not reproduce an actual keyboard.
