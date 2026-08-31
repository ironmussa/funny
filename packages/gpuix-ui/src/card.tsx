import type { StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement } from 'react';

import { useGpuixUiTheme } from './theme';

type NativeDivProps = JSX.IntrinsicElements['div'];
type NativeTextProps = JSX.IntrinsicElements['text'];

export interface CardProps extends Omit<NativeDivProps, 'style'> {
  style?: StyleDesc;
}

export function Card({ style, ...props }: CardProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: theme.colors.panel,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radii.large,
        ...style,
      }}
    />
  );
}

export function CardHeader({ style, ...props }: CardProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: theme.spacing.medium,
        ...style,
      }}
    />
  );
}

export function CardContent({ style, ...props }: CardProps): ReactElement {
  const theme = useGpuixUiTheme();
  return <div {...props} style={{ padding: theme.spacing.medium, ...style }} />;
}

export function CardFooter({ style, ...props }: CardProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.small,
        padding: theme.spacing.medium,
        ...style,
      }}
    />
  );
}

export interface CardTextProps extends Omit<NativeTextProps, 'style'> {
  style?: StyleDesc;
}

export function CardTitle({ style, ...props }: CardTextProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <text
      {...props}
      style={{
        color: theme.colors.text,
        fontSize: theme.fontSizes.title,
        fontWeight: 'bold',
        ...style,
      }}
    />
  );
}

export function CardDescription({ style, ...props }: CardTextProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <text
      {...props}
      style={{ color: theme.colors.muted, fontSize: theme.fontSizes.body, ...style }}
    />
  );
}
