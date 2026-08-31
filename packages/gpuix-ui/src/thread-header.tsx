import { referenceDark } from '@funny/ui-contracts/tokens';
import type { StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement, ReactNode } from 'react';

import { useGpuixUiTheme } from './theme';

type DivProps = JSX.IntrinsicElements['div'];
export interface ThreadHeaderProps extends Omit<DivProps, 'style' | 'title'> {
  title: ReactNode;
  metadata?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  style?: StyleDesc;
}
export function ThreadHeader({
  title,
  metadata,
  leading,
  actions,
  style,
  ...props
}: ThreadHeaderProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: referenceDark.layout.headerHeight,
        paddingLeft: theme.spacing.medium,
        paddingRight: theme.spacing.small,
        gap: theme.spacing.small,
        backgroundColor: theme.colors.background,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
        ...style,
      }}
    >
      {leading}
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
        <text
          style={{
            color: theme.colors.text,
            fontSize: theme.fontSizes.body,
            fontWeight: 'bold',
            lineClamp: 1,
          }}
        >
          {title}
        </text>
        {metadata ? (
          <text
            style={{ color: theme.colors.muted, fontSize: theme.fontSizes.caption, lineClamp: 1 }}
          >
            {metadata}
          </text>
        ) : null}
      </div>
      {actions}
    </div>
  );
}
