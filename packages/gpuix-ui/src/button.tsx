import type { EventPayload, StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';

import { useGpuixUiTheme } from './theme';
import type { GpuixUiTheme } from './theme';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

type NativeDivProps = JSX.IntrinsicElements['div'];

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'small' | 'medium' | 'large';

export interface ButtonProps extends Omit<
  NativeDivProps,
  'children' | 'onBlur' | 'onClick' | 'onFocus' | 'onKeyDown' | 'style'
> {
  children: ReactNode;
  onPress(): void;
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  style?: StyleDesc;
}

function variantStyle(theme: GpuixUiTheme, variant: ButtonVariant): StyleDesc {
  const { colors } = theme;
  switch (variant) {
    case 'secondary':
      return {
        backgroundColor: colors.raised,
        borderColor: colors.border,
        color: colors.text,
        hover: { backgroundColor: colors.border },
      };
    case 'ghost':
      return {
        backgroundColor: colors.panel,
        borderColor: colors.panel,
        color: colors.text,
        hover: { backgroundColor: colors.raised },
      };
    case 'danger':
      return {
        backgroundColor: colors.dangerSurface,
        borderColor: colors.danger,
        color: colors.text,
        hover: { backgroundColor: colors.dangerSurface, borderColor: colors.text },
      };
    case 'primary':
      return {
        backgroundColor: colors.accent,
        borderColor: colors.accent,
        color: colors.accentForeground,
        hover: { borderColor: colors.borderStrong },
      };
  }
}

function sizeStyle(theme: GpuixUiTheme, size: ButtonSize): StyleDesc {
  switch (size) {
    case 'small':
      return { paddingTop: 5, paddingBottom: 5, paddingLeft: 8, paddingRight: 8, gap: 5 };
    case 'large':
      return { paddingTop: 11, paddingBottom: 11, paddingLeft: 16, paddingRight: 16, gap: 8 };
    case 'medium':
      return {
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: theme.spacing.medium,
        paddingRight: theme.spacing.medium,
        gap: 7,
      };
  }
}

export function createButtonStyle({
  theme,
  variant,
  size,
  disabled,
  focused,
  style,
}: {
  theme: GpuixUiTheme;
  variant: ButtonVariant;
  size: ButtonSize;
  disabled: boolean;
  focused: boolean;
  style?: StyleDesc;
}): StyleDesc {
  const themed = variantStyle(theme, variant);
  return {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderWidth: 1,
    borderRadius: theme.radii.medium,
    cursor: disabled ? 'not-allowed' : 'pointer',
    userSelect: 'none',
    opacity: disabled ? 0.55 : 1,
    ...themed,
    ...sizeStyle(theme, size),
    ...(focused ? { borderColor: theme.colors.borderStrong } : {}),
    ...style,
  };
}

function isActivationKey(event: EventPayload): boolean {
  const key = event.key?.toLowerCase();
  return key === 'enter' || key === 'space' || key === ' ';
}

export function Button({
  children,
  onPress,
  disabled = false,
  variant = 'primary',
  size = 'medium',
  style,
  tabIndex,
  ...props
}: ButtonProps): ReactElement {
  const theme = useGpuixUiTheme();
  const [focused, setFocused] = useState(false);
  const press = () => {
    if (!disabled) onPress();
  };
  return (
    <div
      {...props}
      tabIndex={disabled ? -1 : (tabIndex ?? 0)}
      onClick={press}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        if (!disabled && isActivationKey(event)) onPress();
      }}
      style={createButtonStyle({ theme, variant, size, disabled, focused, style })}
    >
      {children}
    </div>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'size'> {
  icon: ReactNode;
  label?: string;
  selected?: boolean;
  size?: ButtonSize;
}

export function IconButton({
  icon,
  label,
  selected = false,
  style,
  variant,
  ...props
}: IconButtonProps): ReactElement {
  const button = (
    <Button
      {...props}
      variant={selected ? 'secondary' : (variant ?? 'ghost')}
      style={{
        width: 34,
        height: 34,
        padding: 0,
        ...style,
      }}
    >
      {icon}
    </Button>
  );
  if (!label) return button;
  return (
    <Tooltip>
      <TooltipTrigger>{button}</TooltipTrigger>
      <TooltipContent>
        <text>{label}</text>
      </TooltipContent>
    </Tooltip>
  );
}
