## Context

The One Dark theme in `globals.css` (`.theme-one-dark` block, lines 162-222) defines all surface colors using HSL values. The lightness values form a layered hierarchy from cards (darkest) to borders (lightest surface). The hue (~220) and saturation (~13%) stay consistent across all surfaces, only lightness varies.

## Goals / Non-Goals

**Goals:**

- Raise all surface lightness values by ~5% to make the theme feel lighter
- Preserve the relative lightness gaps between layers (cards < sidebar < background < muted < input < secondary < border)
- Maintain WCAG contrast ratios for text on all surfaces

**Non-Goals:**

- Changing hue or saturation
- Modifying text colors, accent colors, or status colors
- Touching any other theme
- Adding new CSS variables

## Decisions

### 1. Lightness delta map

All surface variables get +5% lightness. Text and accent colors stay unchanged to preserve contrast.

| Variable               | Current | New   | Delta |
| ---------------------- | ------- | ----- | ----- |
| `--card`               | 11%     | 16%   | +5    |
| `--popover`            | 11%     | 16%   | +5    |
| `--sidebar-background` | 13%     | 18%   | +5    |
| `--background`         | 16.5%   | 21.5% | +5    |
| `--muted`              | 20%     | 25%   | +5    |
| `--accent`             | 20%     | 25%   | +5    |
| `--input`              | 22%     | 27%   | +5    |
| `--secondary`          | 26%     | 31%   | +5    |
| `--sidebar-accent`     | 20%     | 25%   | +5    |
| `--sidebar-border`     | 31%     | 36%   | +5    |
| `--border`             | 33%     | 38%   | +5    |

### 2. Unchanged variables

These stay as-is because they define text/accent colors, not surfaces:

- `--foreground` (82%) — text
- `--card-foreground` (90%) — text on cards
- `--popover-foreground` (90%) — text on popovers
- `--muted-foreground` (55%) — secondary text
- `--primary` (40%) — accent
- `--primary-foreground` (98%) — text on accent
- `--secondary-foreground` (85%) — text on secondary
- `--accent-foreground` (90%) — text on accent surfaces
- `--ring` — focus ring color
- `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent-foreground`, `--sidebar-ring`
- All `--status-*`, `--diff-*`, and `--terminal-*` variables
