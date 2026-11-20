## Why

Dependabot PR #20 bumps `tailwindcss` 3.4.19 → 4.3.0 and fails `lint` + `test` + `e2e`. Tailwind v4 is **not a version bump** — it changes the engine (CSS-first config, new PostCSS plugin, renamed/removed utilities, new color-token model). The `packages/client` styling is a v3-era shadcn/ui setup with a 157-line JS `tailwind.config.ts`, a 1426-line `globals.css`, **4 custom themes**, `<alpha-value>` color tokens, `tailwindcss-animate`, and deep theming of third-party widgets (dockview, tiptap, monaco, xterm, mermaid, recharts, highlight.js). Merging #20 as-is would break the UI across all 4 themes.

This change migrates `packages/client` to Tailwind v4 deliberately, with visual QA of the 4 themes, so the bump lands without regressions.

Scope is **client-only**. No server/runtime/shared changes.

## What Changes

- **Entry directives**: `globals.css` `@tailwind base/components/utilities` → `@import "tailwindcss"`.
- **Build plugin**: `postcss.config` (`tailwindcss` + `autoprefixer`) → `@tailwindcss/postcss` (or the `@tailwindcss/vite` plugin; this is a Vite app). `autoprefixer` is no longer needed (v4 handles vendor prefixing).
- **Config**: `tailwind.config.ts` (JS) → either keep via `@config "./tailwind.config.ts"` (compat) or port `theme.extend` into a CSS `@theme` block. **Decision deferred to design.md** (recommendation: codemod-first, then port what's cheap).
- **Color tokens**: replace the `hsl(var(--x) / <alpha-value>)` pattern — `<alpha-value>` does not exist in v4. Move the `hsl()` wrapping into the variables and/or `@theme inline` so utilities + `/<opacity>` modifiers keep working.
- **Animate plugin**: `tailwindcss-animate` → `tw-animate-css` (the v4-compatible fork) — or inline the handful of `animate-*` utilities actually used.
- **Deprecated utilities** (codemod-handled): `flex-shrink-0` ×308 → `shrink-0`; `flex-shrink`/`flex-grow` → `shrink`/`grow`; the `shadow-*` scale (~107 usages) shifted in v4 (`shadow-sm` → `shadow-xs`, `shadow` → `shadow-sm`, …) and must be remapped or shadows change.
- **The 4 themes** (`:root` light, `.dark`, `.theme-one-dark`, `.theme-dracula`) — each defines ~40 HSL space-separated vars; verify all render correctly under the new token model.
- **QA**: a themes × surfaces visual matrix, plus deciding whether to add visual snapshots (Storybook/Playwright) as a safety net.

## Capabilities

### New Capabilities

- `tailwind-v4`: the client styling pipeline runs on Tailwind v4 (CSS-first entry, `@tailwindcss/postcss`/vite plugin, `@theme` or `@config`), with all 4 themes and the existing component/utility/animation surface preserved.

### Modified Capabilities

<!-- None: there are no existing capability specs under openspec/specs/ for the styling pipeline. -->

## Impact

- **`packages/client/src/globals.css`** (1426 lines) — directives, theme tokens, `<alpha-value>` removal, `@layer`/`@apply` review, the 4 theme blocks.
- **`packages/client/tailwind.config.ts`** (157 lines) — kept via `@config` or ported to `@theme`; the `require('tailwindcss-animate')` plugin swapped.
- **`packages/client/postcss.config.*`** — switch to `@tailwindcss/postcss` (or remove in favor of `@tailwindcss/vite` in `vite.config.ts`).
- **`packages/client/package.json`** — add `tailwindcss@^4`, `@tailwindcss/postcss` (or `@tailwindcss/vite`), `tw-animate-css`; drop `autoprefixer` if unused elsewhere.
- **~310 class-rename sites** across `src/**/*.tsx` (`flex-shrink-0`, `shadow-*`) — codemod-applied, reviewed.
- **29 files** touching themed third-party widgets — visual-regression surface (dockview/tiptap/monaco/xterm/mermaid/recharts/hljs).
- **Storybook + Playwright e2e** — must still build/pass; candidate hosts for visual QA.
- **CI**: the `lint` (oxfmt/oxlint), `test`, `build`, and `e2e` jobs gate the result; #20 closes when master is on v4.
