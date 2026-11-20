## Context

`packages/client` uses Tailwind **v3** with a shadcn/ui "default" setup. Verified during this pass:

- **`components.json`**: `tailwind.config: "tailwind.config.ts"`, `cssVariables: true`, `baseColor: zinc`, `style: default` (the pre-v4 shadcn style; v4 shadcn uses a different token/style).
- **`tailwind.config.ts`** (157 lines): `darkMode: 'class'`, content globs, `theme.extend` with `fontFamily` (3 CSS vars), a large `colors` map (all `hsl(var(--x))`; `status.*` and `diff.*` use `hsl(var(--x) / <alpha-value>)`), `borderRadius` (`var(--radius)`), 7 `keyframes` + 7 `animation`s, and `plugins: [require('tailwindcss-animate')]`.
- **`globals.css`** (1426 lines): `@tailwind base/components/utilities` (3 directives); 4 `@layer` blocks (`base` ×2, `components`, `utilities`); **14 `@apply`**; the 4 theme blocks; and a large body of hand-written CSS for third-party widgets.
- **4 themes** (not light/dark-only): `:root` (light, line 34), `.dark` (101), `.theme-one-dark` (~166), `.theme-dracula` (~230). Each sets ~40 HSL **space-separated** vars (e.g. `--background: 0 0% 100%`). Theme switching toggles a class on a root element.
- **`postcss.config`**: `{ plugins: { tailwindcss: {}, autoprefixer: {} } }`.
- **Deprecated-utility surface** (v4 renames): `flex-shrink-0` ×308, `flex-shrink`/`flex-grow` ×1 each; `shadow*` ×~107 (scale shifted).
- **Third-party theming surface**: 29 files reference `dockview` / `tiptap` / `monaco` / `xterm` / `mermaid` / `recharts` / `hljs`; `globals.css` has dedicated blocks (`.dockview-theme-funny`, `.tiptap-prompt-editor .*`, `.code-viewer .hljs`).

The whole UI is class-based theming via `hsl(var(--token))`, so a token-model regression shows up **everywhere, in all 4 palettes**, and there are currently **no visual snapshots** to catch it.

## The central decision — `@config` compat vs CSS-first port

```
            A) @config compat                 B) CSS-first port
            ─────────────────────             ─────────────────────
 config     keep tailwind.config.ts           theme.extend → @theme in CSS
 effort     low                               high
 risk       `<alpha-value>` may not work      re-wire ~40 tokens × 4 themes
            under v4 the same way             but explicit & testable
 future     `@config` is a bridge, not        idiomatic v4, aligns with
            the v4 end-state                  shadcn-v4
```

**Recommendation: codemod-first.** Run `npx @tailwindcss/upgrade` on an isolated branch. It automates the directive swap, PostCSS plugin, most config→CSS porting, and the `flex-shrink-0`/`shadow-*` renames. Treat its output as the starting point:

- If the codemod produces a clean `@theme` port → go with **B** (proper v4).
- If the 4 themes / `<alpha-value>` get messy → keep the JS config via **`@config`** (A) for this change and leave a follow-up to finish the port.

This decouples the _mechanical_ migration (codemod) from the _judgment_ parts (4 themes, alpha tokens, visual QA).

### Spike findings (resolved → go with **B**, CSS-first port)

Ran `bunx @tailwindcss/upgrade --force` on `spike/tailwind-v4-codemod` (tailwindcss `4.3.0`). Results:

- **Directives** → `@import 'tailwindcss';`; the `highlight.js` CSS import got `layer(base)` appended. ✓
- **Config** → the codemod **deleted `tailwind.config.ts`** and ported `theme.extend` into a CSS `@theme` block (approach **B**). It did NOT leave an `@config` bridge.
- **`<alpha-value>` tokens** → the placeholder was simply dropped: `--color-status-success: hsl(var(--status-success));` etc. In v4 the `/<opacity>` modifier now composes via `color-mix()`, so the old `<alpha-value>` machinery is gone and opacity modifiers keep working. ✓
- **PostCSS** → `@tailwindcss/postcss` swapped in, `autoprefixer` removed. ✓ (Stayed on PostCSS, not the Vite plugin — fewer moving parts.)
- **Utility renames** → correct and extensive across ~155 files: `w-[--x]`→`w-(--x)`, `has-[[data-variant=inset]]`→`has-data-[variant=inset]`, `theme(spacing.4)`→`--spacing(4)`, `left-[calc(var(--x)*-1)]`→`-left-(--x)`, plus the `flex-shrink-0`/`shadow-*`/`rounded-*` scale shifts. ✓

**Codemod bugs to fix (do NOT carry into the real change):**

1. **`outline` → `outline-solid` false-positives** (15 sites): the codemod rewrote the **string literal** `variant="outline"` (a shadcn Button/Badge prop value, plus Storybook `options` arrays) to `"outline-solid"`, which is not a valid variant → breaks `tsc -b`. Revert all back to `'outline'`.
2. **`@theme` should be `@theme inline`**: the codemod emitted plain `@theme`, which (a) re-emits `--color-*` vars and (b) produced a self-referential `--font-sans: var(--font-sans)` cycle. `@theme inline` (the shadcn-v4 idiom) substitutes at the use-site so the class-based theme overrides on the inner `--background`/`--font-*` vars cascade correctly.
3. **Broken `@utility md-search-match`**: `mark.md-search-match` was converted to `@utility md-search-match { &mark { … } }`; `&mark` is invalid nesting. Keep this as a plain CSS rule instead.
4. **Animate plugin**: codemod kept `require('tailwindcss-animate')` is moot (config deleted) but left the dep; swap to `tw-animate-css` per Task 1.4.

**Decision: B (CSS-first `@theme inline`).** Keep the codemod's mechanical output; fix the four issues above.

### Themes scope correction

`globals.css` actually defines **10** theme blocks, not 4: `:root` (light), `.dark`, `.theme-one-dark`, `.theme-dracula`, `.theme-github-dark`, `.theme-night-owl`, `.theme-monochrome`, `.theme-monochrome-dark`, `.theme-sunrise`, `.theme-catppuccin`. They all share the same token list, so the marginal cost is re-checking values, not new wiring — migrate all 10.

## The `<alpha-value>` problem

v3 lets a token be `hsl(var(--status-success) / <alpha-value>)` so `bg-status-success/50` injects the opacity. v4 drops `<alpha-value>`; instead the **variable holds a real color** and v4's `/<opacity>` modifier uses `color-mix()`. Options:

1. Store full colors in the vars (`--status-success: hsl(142 70% 45%)`) and map them in `@theme inline` so `/<opacity>` works via `color-mix`. (Cleanest, v4-native.)
2. Keep space-separated HSL and wrap at the `@theme` mapping. (Closer to today; verify `/<opacity>` still composes.)

Whichever is chosen, audit every `bg-status-*/NN` / `text-diff-*/NN` usage to confirm opacity still renders.

## Themes scope question

`light` + `.dark` are the critical defaults. `.theme-one-dark` and `.theme-dracula` are extra palettes. **Open decision**: migrate all 4 in this change, or ship `light`/`.dark` first and treat `one-dark`/`dracula` as a fast-follow. (Recommendation: do all 4 — they share the token list, so the marginal cost is re-checking values, not new wiring.)

## QA strategy

The risk is visual, not type/test. Proposed safety net (open decision on appetite):

- **Storybook** already renders components with Tailwind — sweep the stories in each of the 4 themes.
- **Playwright e2e** can capture screenshots; consider a small visual-snapshot pass on a few key screens × 4 themes as a regression gate.
- Minimum bar (no new tooling): manual eyeball of the **themes × surfaces** matrix below before merge.

```
                 light   .dark   one-dark   dracula
 shadcn base       ·       ·         ·         ·
 diff viewer       ·       ·         ·         ·    ← status/diff (<alpha-value>)
 tiptap editor     ·       ·         ·         ·
 dockview panels   ·       ·         ·         ·    ← .dockview-theme-funny
 terminal/xterm    ·       ·         ·         ·
 monaco/mermaid    ·       ·         ·         ·
 recharts          ·       ·         ·         ·
```

## Risks

- **`<alpha-value>` removal** silently flattens opacities on status/diff colors — most likely regression.
- **`shadow-*` rescale** changes elevation everywhere if the codemod misses any.
- **Third-party widget themes** (dockview/tiptap/hljs) read the same vars — break together if the token model shifts.
- **`tailwindcss-animate` → `tw-animate-css`** may not be 1:1 for every `animate-*` used.
- **Storybook + e2e** both compile Tailwind — a config mistake fails CI in two more places.

## What we are NOT doing

- Not adopting the new shadcn-v4 component style / OKLCH palette wholesale (separate, optional follow-up).
- Not touching server/runtime/shared.
- Not redesigning any theme — values stay visually equivalent.
