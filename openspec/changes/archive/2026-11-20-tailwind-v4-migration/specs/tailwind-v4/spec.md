## ADDED Requirements

### Requirement: Client styling compiles on Tailwind v4

The `packages/client` build pipeline SHALL compile styles with Tailwind CSS v4 (CSS-first `@import "tailwindcss"`, `@tailwindcss/postcss` or the Vite plugin) while preserving every theme token, utility, component layer, and animation that the v3 setup provided.

#### Scenario: All four themes render equivalently

- **WHEN** the app is loaded under each theme — `:root` (light), `.dark`, `.theme-one-dark`, `.theme-dracula`
- **THEN** background/foreground/primary/secondary/accent/muted/popover/card/sidebar colors, `status.*` and `diff.*` colors **including their `/<opacity>` modifiers**, `borderRadius`, fonts, and the custom `animate-*` keyframes all match the v3 visual baseline

#### Scenario: Themed third-party widgets keep their styling

- **WHEN** the diff viewer, tiptap prompt editor, dockview panels, xterm terminal, monaco editor, mermaid, recharts, and highlight.js code blocks are rendered
- **THEN** they read the same theme variables and look unchanged across all four themes

#### Scenario: CI passes with tailwindcss v4 installed

- **WHEN** `tailwindcss` is at `^4` and CI runs `lint`, `test`, `build`, the E2E workflow, and the Storybook build
- **THEN** every job passes

#### Scenario: Deprecated v3 utilities are migrated, not left dangling

- **WHEN** the codebase is scanned after migration
- **THEN** no `flex-shrink-0` / `flex-shrink` / `flex-grow` remain (replaced by `shrink-0` / `shrink` / `grow`) and the `shadow-*` scale uses v4 names, so elevation and layout are unchanged
