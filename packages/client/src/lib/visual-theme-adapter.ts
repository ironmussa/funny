import type { VisualContract } from '@funny/ui-contracts/tokens';

export type VisualCssVariables = Record<`--${string}`, string>;

export function createVisualCssVariables(contract: VisualContract): VisualCssVariables {
  return {
    '--background': contract.colors.canvas,
    '--foreground': contract.colors.text,
    '--card': contract.colors.surface,
    '--card-foreground': contract.colors.text,
    '--popover': contract.colors.overlay,
    '--popover-foreground': contract.colors.text,
    '--accent': contract.colors.accent,
    '--accent-foreground': contract.colors.accentText,
    '--muted-foreground': contract.colors.textMuted,
    '--border': contract.colors.border,
    '--input': contract.colors.input,
    '--ring': contract.colors.borderStrong,
    '--sidebar-background': contract.colors.sidebar,
    '--sidebar-foreground': contract.colors.text,
    '--sidebar-accent': contract.colors.accent,
    '--sidebar-accent-foreground': contract.colors.accentText,
    '--sidebar-border': contract.colors.border,
    '--sidebar-ring': contract.colors.borderStrong,
  };
}
