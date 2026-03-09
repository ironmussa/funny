# Storybook Stories Implementation Plan

## Goal
Add Storybook stories for UI primitive components and key presentational components. Stories only (no interaction testing).

## Scope — 13 story files

### Phase 1: shadcn/ui primitives (8 files)
These are pure presentational components with no store/API dependencies.

| # | Component | File to create | Key stories |
|---|-----------|----------------|-------------|
| 1 | **Button** | `ui/button.stories.tsx` | All 6 variants x 4 sizes, loading state, disabled, with icon, asChild |
| 2 | **Badge** | `ui/badge.stories.tsx` | All 4 variants (default, secondary, destructive, outline) |
| 3 | **Input** | `ui/input.stories.tsx` | Default, placeholder, disabled, with type (password, email), file input |
| 4 | **Checkbox** | `ui/checkbox.stories.tsx` | Unchecked, checked, disabled, with label |
| 5 | **Avatar** | `ui/avatar.stories.tsx` | All 3 sizes (sm, default, lg), with image, with fallback |
| 6 | **Separator** | `ui/separator.stories.tsx` | Horizontal, vertical |
| 7 | **Skeleton** | `ui/skeleton.stories.tsx` | Basic shapes (line, circle, card-like layout) |
| 8 | **Tooltip** | `ui/tooltip.stories.tsx` | Basic tooltip, different sides (top, right, bottom, left) |

### Phase 2: Custom presentational components (5 files)

| # | Component | File to create | Key stories | Notes |
|---|-----------|----------------|-------------|-------|
| 9 | **ProjectChip** | `ui/project-chip.stories.tsx` | Default color, custom color, sm size, long name truncation | Pure — no deps |
| 10 | **HighlightText** | `ui/highlight-text.stories.tsx` | No query, partial match, multiple matches, accent-insensitive | Pure — no deps |
| 11 | **StatusBadge** | `StatusBadge.stories.tsx` | All 9 statuses (idle, running, completed, etc.) | Uses react-i18next — need i18n decorator in preview |
| 12 | **D4CAnimation** | `D4CAnimation.stories.tsx` | Default size, sm size | Uses motion/react — works as-is |
| 13 | **AppShellSkeleton** | `AppShellSkeleton.stories.tsx` | Default (fullscreen layout) | Pure — uses only Skeleton |

## Implementation Details

### Step 0: Update Storybook preview with i18n support
StatusBadge uses `useTranslation()` from react-i18next. Add `import '../src/i18n/config';` to `packages/client/.storybook/preview.tsx`.

### Steps 1-13: Create story files
Each story file follows the existing pattern from `WorktreeSetupProgress.stories.tsx`:
- Import `Meta`, `StoryObj` from `@storybook/react-vite`
- Title: `UI/<Name>` for primitives, `Components/<Name>` for others
- Use `layout: 'centered'` parameter
- Export named stories for each variant/state
- Co-locate stories next to their component

## Files created/modified (14 total)
1. `packages/client/.storybook/preview.tsx` — add i18n import (MODIFY)
2-9. `packages/client/src/components/ui/*.stories.tsx` (8 CREATE)
10-14. `packages/client/src/components/*.stories.tsx` (5 CREATE)

## Verification
Run `bun run build` in `packages/client` to verify TypeScript compilation.
