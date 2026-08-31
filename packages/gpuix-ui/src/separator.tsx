import type { StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement } from 'react';

import { useGpuixUiTheme } from './theme';

type NativeDivProps = JSX.IntrinsicElements['div'];

export interface SeparatorProps extends Omit<NativeDivProps, 'children' | 'style'> {
  orientation?: 'horizontal' | 'vertical';
  style?: StyleDesc;
}

export function Separator({
  orientation = 'horizontal',
  style,
  ...props
}: SeparatorProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        flexShrink: 0,
        backgroundColor: theme.colors.border,
        ...(orientation === 'horizontal'
          ? { width: '100%', height: 1 }
          : { width: 1, height: '100%' }),
        ...style,
      }}
    />
  );
}
