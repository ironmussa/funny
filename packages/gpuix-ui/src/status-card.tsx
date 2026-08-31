import type { StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement, ReactNode } from 'react';

import { Badge } from './badge';
import { useGpuixUiTheme } from './theme';

type DivProps = JSX.IntrinsicElements['div'];
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export interface StatusCardProps extends Omit<DivProps, 'style' | 'title'> {
  title: ReactNode;
  detail?: ReactNode;
  tone?: StatusTone;
  status?: string;
  style?: StyleDesc;
}

export function StatusCard({
  title,
  detail,
  tone = 'neutral',
  status,
  style,
  children,
  ...props
}: StatusCardProps): ReactElement {
  const theme = useGpuixUiTheme();
  const border =
    tone === 'danger'
      ? theme.colors.danger
      : tone === 'warning'
        ? theme.colors.warning
        : tone === 'success'
          ? theme.colors.success
          : tone === 'info'
            ? theme.colors.borderStrong
            : theme.colors.border;
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        padding: theme.spacing.medium,
        backgroundColor: theme.colors.panel,
        borderWidth: 1,
        borderColor: border,
        borderRadius: theme.radii.large,
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <text style={{ color: theme.colors.text, fontWeight: 'bold' }}>{title}</text>
        {status ? (
          <Badge
            variant={
              tone === 'danger'
                ? 'danger'
                : tone === 'warning'
                  ? 'warning'
                  : tone === 'success'
                    ? 'success'
                    : tone === 'info'
                      ? 'accent'
                      : 'neutral'
            }
          >
            {status}
          </Badge>
        ) : null}
      </div>
      {detail ? (
        <text style={{ color: theme.colors.muted, fontSize: theme.fontSizes.caption }}>
          {detail}
        </text>
      ) : null}
      {children}
    </div>
  );
}

export const ToolCallCard = StatusCard;
export const TodoCard = StatusCard;
export const PermissionCard = StatusCard;
