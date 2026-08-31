import type { EventPayload, StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement } from 'react';
import { useState } from 'react';

import { useGpuixUiTheme } from './theme';

type NativeDivProps = JSX.IntrinsicElements['div'];

export interface NavItemProps extends Omit<
  NativeDivProps,
  'onBlur' | 'onClick' | 'onFocus' | 'onKeyDown' | 'style'
> {
  selected?: boolean;
  onSelect(): void;
  style?: StyleDesc;
}

function isActivationKey(event: EventPayload): boolean {
  const key = event.key?.toLowerCase();
  return key === 'enter' || key === 'space' || key === ' ';
}

export function NavItem({
  selected = false,
  onSelect,
  style,
  tabIndex = 0,
  ...props
}: NavItemProps): ReactElement {
  const theme = useGpuixUiTheme();
  const [focused, setFocused] = useState(false);
  return (
    <div
      {...props}
      tabIndex={tabIndex}
      onClick={onSelect}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        if (isActivationKey(event)) onSelect();
      }}
      style={{
        padding: theme.spacing.small,
        borderRadius: theme.radii.small,
        cursor: 'pointer',
        userSelect: 'none',
        backgroundColor: selected ? theme.colors.accent : theme.colors.panel,
        borderWidth: 1,
        borderColor: focused
          ? theme.colors.borderStrong
          : selected
            ? theme.colors.borderStrong
            : theme.colors.panel,
        hover: { backgroundColor: selected ? theme.colors.accent : theme.colors.raised },
        ...style,
      }}
    />
  );
}
