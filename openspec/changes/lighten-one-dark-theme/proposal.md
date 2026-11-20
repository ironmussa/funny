## Why

The One Dark theme's background (`16.5%` lightness) feels heavy and dense. A subtle +5% lightness bump across the entire color stack makes the interface feel lighter and more breathable without losing the dark theme character. This is a pure CSS variable change — no logic, no components, no runtime impact.

## What Changes

- Increase lightness by ~5 percentage points for all surface-level HSL variables in the `.theme-one-dark` block in `packages/client/src/globals.css`
- Affected variables: `background`, `card`, `popover`, `secondary`, `muted`, `accent`, `input`, `border`, `sidebar-background`, `sidebar-accent`, `sidebar-border`
- Unaffected: `foreground`, `muted-foreground`, `primary`, `primary-foreground`, `ring`, status colors, diff colors, terminal ANSI colors

## Capabilities

### Modified Capabilities

- `.theme-one-dark` CSS variables in `globals.css`

## Impact

- **`packages/client/src/globals.css`** — ~15 HSL variable values changed within `.theme-one-dark`
- No database changes
- No API changes
- No component changes
- No new dependencies
