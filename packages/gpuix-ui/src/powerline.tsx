import type { StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement, ReactNode } from 'react';

import { Icon } from './icon';
import { useGpuixUiTheme } from './theme';

type DivProps = JSX.IntrinsicElements['div'];

export function Powerline({
  style,
  ...props
}: Omit<DivProps, 'style'> & { style?: StyleDesc }): ReactElement {
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        gap: 3,
        ...style,
      }}
    />
  );
}

export function PowerlineSegment({
  icon,
  children,
  color,
  style,
  ...props
}: Omit<DivProps, 'style'> & {
  icon?: ReactNode;
  color?: string;
  style?: StyleDesc;
}): ReactElement | null {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        gap: 4,
        paddingTop: 2,
        paddingBottom: 2,
        paddingLeft: 6,
        paddingRight: 6,
        borderRadius: theme.radii.small,
        backgroundColor: color ?? theme.colors.raised,
        ...style,
      }}
    >
      {icon}
      <text style={{ color: theme.colors.text, fontSize: theme.fontSizes.caption, lineClamp: 1 }}>
        {children}
      </text>
    </div>
  );
}

export function DiffStats({
  files,
  added,
  deleted,
  style,
  ...props
}: Omit<DivProps, 'style'> & {
  files: number;
  added: number;
  deleted: number;
  style?: StyleDesc;
}): ReactElement | null {
  const theme = useGpuixUiTheme();
  if (files <= 0 && added <= 0 && deleted <= 0) return null;
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        gap: 3,
        paddingLeft: 4,
        paddingRight: 4,
        ...style,
      }}
    >
      <Icon name="file" size={10} color={theme.colors.muted} />
      <text style={{ color: theme.colors.muted, fontSize: theme.fontSizes.caption }}>{files}</text>
      <text style={{ color: theme.colors.success, fontSize: theme.fontSizes.caption }}>
        +{added}
      </text>
      <text style={{ color: theme.colors.danger, fontSize: theme.fontSizes.caption }}>
        -{deleted}
      </text>
    </div>
  );
}

export type GitChangesIndicatorKind = 'loading' | 'clean' | 'changed';

export function gitChangesIndicatorKind(
  files: number | null,
  added: number | null,
  deleted: number | null,
): GitChangesIndicatorKind {
  if (files === null || added === null || deleted === null) return 'loading';
  return files <= 0 && added <= 0 && deleted <= 0 ? 'clean' : 'changed';
}

export function GitChangesIndicator({
  files,
  added,
  deleted,
  style,
  ...props
}: Omit<DivProps, 'style'> & {
  files: number | null;
  added: number | null;
  deleted: number | null;
  style?: StyleDesc;
}): ReactElement {
  const theme = useGpuixUiTheme();
  const kind = gitChangesIndicatorKind(files, added, deleted);
  if (kind === 'changed') {
    return (
      <DiffStats
        {...props}
        files={files ?? 0}
        added={added ?? 0}
        deleted={deleted ?? 0}
        style={style}
      />
    );
  }
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        gap: 3,
        paddingLeft: 4,
        paddingRight: 4,
        ...style,
      }}
    >
      <Icon
        name={kind === 'clean' ? 'circle-check' : 'clock'}
        size={10}
        color={kind === 'clean' ? theme.colors.success : theme.colors.muted}
      />
      <text
        style={{
          color: kind === 'clean' ? theme.colors.success : theme.colors.muted,
          fontSize: theme.fontSizes.caption,
        }}
      >
        {kind === 'clean' ? 'clean' : '…'}
      </text>
    </div>
  );
}

export function GitChangesSummary({
  files,
  added,
  deleted,
  label = 'Changes',
  style,
  ...props
}: Omit<DivProps, 'style'> & {
  files: number | null;
  added: number | null;
  deleted: number | null;
  label?: ReactNode;
  style?: StyleDesc;
}): ReactElement | null {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        minHeight: 30,
        gap: 6,
        paddingLeft: 8,
        paddingRight: 8,
        backgroundColor: theme.colors.panel,
        borderTopWidth: 1,
        borderColor: theme.colors.border,
        ...style,
      }}
    >
      <Icon name="activity" size={12} color={theme.colors.muted} />
      <text
        style={{
          color: theme.colors.muted,
          fontSize: theme.fontSizes.caption,
          lineClamp: 1,
          flexGrow: 1,
        }}
      >
        {label}
      </text>
      <GitChangesIndicator files={files} added={added} deleted={deleted} />
    </div>
  );
}
