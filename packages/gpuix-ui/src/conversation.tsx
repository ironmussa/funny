import { referenceDark } from '@funny/ui-contracts/tokens';
import type { EventPayload, StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement, ReactNode } from 'react';

import { useGpuixUiTheme } from './theme';

type DivProps = JSX.IntrinsicElements['div'];
export interface ConversationProps extends Omit<DivProps, 'style'> {
  compact?: boolean;
  style?: StyleDesc;
}

export function ConversationViewport({
  compact = false,
  style,
  ...props
}: ConversationProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minHeight: 0,
        width: '100%',
        padding: compact ? theme.spacing.small : theme.spacing.large,
        backgroundColor: theme.colors.background,
        ...style,
      }}
    />
  );
}

export function ConversationRow({
  compact = false,
  style,
  ...props
}: ConversationProps): ReactElement {
  return (
    <div
      {...props}
      style={{
        width: '100%',
        maxWidth: referenceDark.layout.conversationMaximumWidth,
        alignSelf: 'center',
        paddingTop: compact ? 5 : 8,
        paddingBottom: compact ? 5 : 8,
        ...style,
      }}
    />
  );
}

export interface UserMessageCardProps extends ConversationProps {
  onActivate?: () => void;
}
export function UserMessageCard({
  onActivate,
  style,
  tabIndex,
  ...props
}: UserMessageCardProps): ReactElement {
  const theme = useGpuixUiTheme();
  const activateOnKey = (event: EventPayload) => {
    if (event.key?.toLowerCase() === 'enter' || event.key === ' ') onActivate?.();
  };
  return (
    <div
      {...props}
      tabIndex={onActivate ? (tabIndex ?? 0) : tabIndex}
      onClick={onActivate}
      onKeyDown={onActivate ? activateOnKey : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing.small,
        width: '100%',
        padding: theme.spacing.medium,
        color: referenceDark.colors.inverseText,
        backgroundColor: referenceDark.colors.inverseSurface,
        borderWidth: onActivate ? 1 : 0,
        borderColor: referenceDark.colors.inverseSurface,
        borderRadius: theme.radii.large,
        cursor: onActivate ? 'pointer' : 'default',
        boxShadow: { offsetX: 0, offsetY: 3, blurRadius: 9, spreadRadius: 0, color: '#00000044' },
        ...style,
      }}
    />
  );
}

export function AssistantMessage({
  source,
  rich = true,
  style,
  fallback,
}: {
  source: string;
  rich?: boolean;
  style?: StyleDesc;
  fallback?: ReactNode;
}): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing.small,
        width: '100%',
        color: theme.colors.text,
        ...style,
      }}
    >
      {rich ? <markdown source={source} /> : (fallback ?? <text>{source}</text>)}
    </div>
  );
}
