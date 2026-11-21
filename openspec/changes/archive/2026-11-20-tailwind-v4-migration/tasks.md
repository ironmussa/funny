## 0. Spike — measure the real diff (isolated branch)

- [x] 0.1 Create a throwaway branch. Run `cd packages/client && npx @tailwindcss/upgrade` (the official v3→v4 codemod). Do NOT commit yet.
- [x] 0.2 Inspect what it changed: `git diff --stat`. Note specifically how it handled (a) `globals.css` directives, (b) `tailwind.config.ts` → `@theme` vs left as `@config`, (c) the 4 theme blocks, (d) `<alpha-value>` tokens, (e) `flex-shrink-0`/`shadow-*` renames, (f) `postcss.config`.
- [x] 0.3 `bun run build` (client) + `bun run build-storybook` on the spike. Record every error. This decides **A (`@config`) vs B (`@theme`)** in `design.md`.
- [x] 0.4 Write findings back into `design.md` (resolve the compat-vs-port open decision) before starting the real change.

## 1. Build pipeline / infra

- [x] 1.1 `packages/client/package.json`: add `tailwindcss@^4`, `@tailwindcss/postcss` (or `@tailwindcss/vite`), `tw-animate-css`; remove `autoprefixer` if nothing else uses it. `bun install`. — codemod added `@tailwindcss/postcss@^4.3.0`, removed `autoprefixer`, bumped `tailwindcss@^4.3.0`; swapped `tailwindcss-animate` → `tw-animate-css@^1.4.0`.
- [x] 1.2 If using the Vite plugin: add `@tailwindcss/vite` to `packages/client/vite.config.ts` plugins and delete `postcss.config.*`. Otherwise: set `postcss.config` to `{ plugins: { '@tailwindcss/postcss': {} } }`. — went PostCSS route; `postcss.config.js` now `{ '@tailwindcss/postcss': {} }`.
- [x] 1.3 `globals.css`: replace the 3 `@tailwind base/components/utilities` directives with `@import "tailwindcss";`. — done; highlight.js import got `layer(base)`.
- [x] 1.4 Swap the animate plugin: import `tw-animate-css` (per its v4 docs) and drop `require('tailwindcss-animate')` from `tailwind.config.ts` (or remove the JS plugin entirely if going CSS-first). Grep `animate-` usages in `src/**` and confirm each still resolves. — `@import 'tw-animate-css';` added; JS config deleted; `animate-in/out`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*` + custom `animate-fade-in/scale-in/mic-wave` all resolve (build clean).

## 2. Config + tokens

- [x] 2.1 Per the spike decision: either keep `tailwind.config.ts` via `@config "../tailwind.config.ts"` in `globals.css`, OR port `theme.extend` (fontFamily, colors, borderRadius, keyframes, animation) into a CSS `@theme` block. — ported to `@theme inline` (changed codemod's plain `@theme` → `inline` to fix the `--font-sans: var(--font-sans)` self-ref and keep class-based theme overrides cascading); `tailwind.config.ts` deleted.
- [x] 2.2 Resolve `<alpha-value>`: convert `status.*` and `diff.*` tokens to the v4 model (full-color vars + `@theme inline`, or verified space-separated wrapping). Audit every `bg-status-*/NN`, `text-status-*/NN`, `*-diff-*/NN` opacity usage in `src/**` and confirm it renders. — `<alpha-value>` dropped; verified generated CSS emits `color-mix(in oklab, hsl(var(--status-*)) N%, transparent)` for every opacity modifier, with the inner `hsl(var(--…))` cascading per theme.
- [x] 2.3 Verify `borderRadius` (`var(--radius)`), `fontFamily` (`var(--font-*)`) tokens still map. — generated CSS: `.rounded-lg{border-radius:var(--radius)}`, `.rounded-md/sm` = `calc(var(--radius) - 2px/4px)`; bare `.rounded` stays `.25rem` (v3 parity); fonts map via `@theme inline` `--font-*`.

## 3. The themes (10, not 4 — see design.md)

- [x] 3.1 `:root` (light) — confirm all ~40 tokens resolve under the new model. — token block untouched by codemod; resolves via `@theme inline` → `hsl(var(--…))`.
- [x] 3.2 `.dark` — same. — untouched; cascades via `@custom-variant dark` + class.
- [x] 3.3 `.theme-one-dark` — same. — untouched.
- [x] 3.4 `.theme-dracula` — same (plus `.theme-github-dark`, `.theme-night-owl`, `.theme-monochrome`, `.theme-monochrome-dark`, `.theme-sunrise`, `.theme-catppuccin`). — all 10 blocks untouched (0 token-line changes in the diff).
- [x] 3.5 Verify the theme-switch mechanism (class toggle) still cascades all tokens. Check the settings → appearance theme picker actually swaps live. — mechanism structurally unchanged (class toggle over plain `@layer base` CSS vars; `@theme inline` substitutes at use-site so overrides cascade). **Live in-browser swap not verified headlessly — see Section 6 (needs human visual QA).**

## 4. Deprecated utilities + hand-written CSS

- [x] 4.1 Confirm the codemod renamed `flex-shrink-0`→`shrink-0` (×308), `flex-shrink`/`flex-grow`→`shrink`/`grow`, and the `shadow-*` scale (×~107). Grep for any leftover v3 names. — no `flex-shrink*`/`flex-grow`/`outline-none`/bare `shadow` remain; custom `rounded-sm/md/lg` correctly carry `--radius` tokens. **Fixed codemod false-positives: 15 `variant="outline"` → `"outline-solid"` string-prop corruptions reverted.**
- [x] 4.2 Review the 14 `@apply` usages and the 4 `@layer` blocks in `globals.css` for v4 compatibility (notably `@apply` of custom classes; v4 needs `@reference` only in module-scoped CSS — N/A here, but verify). — all `@apply` resolve (build clean, single-file scope so no `@reference` needed). **Fixed broken codemod `@utility md-search-match { &mark }` → plain `mark.md-search-match` rule.**
- [x] 4.3 Review the hand-written widget blocks that read theme vars: `.dockview-theme-funny`, `.tiptap-prompt-editor .*` (file-mention/slash-command/symbol-mention `::before`), `.code-viewer .hljs`, custom scrollbars, `.thread-container/.thread-timeline`. These are plain CSS — should survive, but confirm no `theme()` calls or removed at-rules. — all untouched by codemod, no `theme()` calls; survive as plain CSS reading `hsl(var(--…))`.

## 5. Verification (CI parity)

- [x] 5.1 `bun run --cwd packages/client build` (tsc -b + vite build) — clean. — passes (tsc + vite, ~2.8s).
- [x] 5.2 `bun run --cwd packages/client build-storybook` — clean (pre-push hook runs this). — "Storybook build completed successfully".
- [x] 5.3 `bun run --cwd packages/client test` + `bunx oxfmt --check .` + `bun run lint` — green. — tests 1285 pass / 6 skip; oxfmt clean on all changed files; oxlint warnings-only (pre-existing `max-lines`/`exhaustive-deps`), no new errors.
- [ ] 5.4 e2e: `bun run test:e2e` locally (or rely on the E2E workflow on the PR). — **deferred: cannot start a server/browser headlessly (agent safety rule). Rely on the E2E workflow on the PR.**

## 6. Visual QA — themes × surfaces matrix

- [ ] 6.1 Decide QA appetite (see design.md): add Storybook/Playwright visual snapshots, or manual-only.
- [ ] 6.2 Walk the matrix in each of the 4 themes: shadcn base, diff viewer (opacity!), tiptap editor, dockview panels, terminal/xterm, monaco/mermaid, recharts.
- [ ] 6.3 Spot-check `/<opacity>` modifiers on status/diff colors specifically (highest-risk regression).

## 7. Ship

- [x] 7.1 Land the v4 migration on master (its own change), then bump `tailwindcss` to ^4 — Dependabot #20 auto-closes once master is on v4. — committed to master as `f8fecafa` (single squashed commit, `tailwindcss@^4.3.0` in package.json). **Not pushed to origin yet** (awaiting OK); Dependabot #20 closes after this reaches origin/master.
- [ ] 7.2 (Optional follow-up) adopt shadcn-v4 component style / OKLCH palette — separate change.
