## Why

Prompt input selectors currently open compact popovers and lateral submenus that are difficult to operate on a phone. Mobile users need full-width, touch-friendly selection panels while desktop users retain the existing interactions.

## What Changes

- Below 768px, present prompt model/effort, mode, template, and branch selectors in bottom drawers.
- Provide large option rows, visible selection, accessible titles, explicit close controls, and scrollable content.
- Choose model effort inside the same drawer rather than a lateral submenu; commit only when selection is complete.
- Preserve branch search and existing option availability, callbacks, and business rules.
- Limit adaptation to prompt input controls, including its supplied branch context bar; retain desktop behavior and selectors elsewhere.

## Capabilities

### New Capabilities

- `mobile-prompt-input-selectors`: Responsive presentation and selection behavior for prompt input controls on mobile.

### Modified Capabilities

None.

## Impact

- Client UI: `PromptInputUI.tsx`, prompt branch context integration in `thread/NewThreadContextBar.tsx`, and an explicitly opted-in presentation for `SearchablePicker.tsx` / `BranchPicker`.
- Shared mobile selection shell using shadcn Drawer and the existing `useIsMobile` breakpoint; add the Drawer dependency required by the project's Radix-compatible shadcn implementation.
- English/Spanish labels, component tests, and mobile/desktop browser verification.
- No server, persistence, provider API, or GPU renderer changes.
