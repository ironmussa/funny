import type { StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement } from 'react';

import { useGpuixUiTheme } from './theme';

type NativeDivProps = JSX.IntrinsicElements['div'];

export type BadgeVariant = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends Omit<NativeDivProps, 'style'> {
  variant?: BadgeVariant;
  style?: StyleDesc;
}

export function Badge({ variant = 'neutral', style, ...props }: BadgeProps): ReactElement {
  const theme = useGpuixUiTheme();
  const color =
    variant === 'accent'
      ? theme.colors.borderStrong
      : variant === 'success'
        ? theme.colors.success
        : variant === 'warning'
          ? theme.colors.warning
          : variant === 'danger'
            ? theme.colors.danger
            : theme.colors.muted;
  return (
    <div
      {...props}
      style={{
        alignSelf: 'flex-start',
        paddingTop: 3,
        paddingBottom: 3,
        paddingLeft: 7,
        paddingRight: 7,
        borderWidth: 1,
        borderColor: color,
        borderRadius: theme.radii.pill,
        backgroundColor: theme.colors.raised,
        color,
        fontSize: theme.fontSizes.caption,
        ...style,
      }}
    />
  );
}
