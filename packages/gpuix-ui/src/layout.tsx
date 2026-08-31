import { referenceDark } from '@funny/ui-contracts/tokens';
import type { StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement } from 'react';

import { useGpuixUiTheme } from './theme';

type DivProps = JSX.IntrinsicElements['div'];
export interface LayoutProps extends Omit<DivProps, 'style'> {
  style?: StyleDesc;
}

export function Stack({ style, ...props }: LayoutProps): ReactElement {
  return <div {...props} style={{ display: 'flex', flexDirection: 'column', gap: 8, ...style }} />;
}

export function Inline({ style, ...props }: LayoutProps): ReactElement {
  return (
    <div
      {...props}
      style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, ...style }}
    />
  );
}

export function Surface({ style, ...props }: LayoutProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        backgroundColor: theme.colors.panel,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radii.large,
        ...style,
      }}
    />
  );
}

export function CenteredContent({ style, ...props }: LayoutProps): ReactElement {
  return (
    <div
      {...props}
      style={{
        width: '100%',
        maxWidth: referenceDark.layout.conversationMaximumWidth,
        alignSelf: 'center',
        ...style,
      }}
    />
  );
}

export function AppShell({ style, ...props }: LayoutProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100%',
        height: '100%',
        minHeight: 0,
        backgroundColor: theme.colors.background,
        color: theme.colors.text,
        ...style,
      }}
    />
  );
}
