import { referenceDark } from '@funny/ui-contracts/tokens';
import type { StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement } from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { useGpuixUiTheme } from './theme';

type DivProps = JSX.IntrinsicElements['div'];
export interface ComposerProps extends Omit<DivProps, 'style'> {
  lifecycle?: 'idle' | 'pending' | 'running' | 'waiting' | 'read-only' | 'error';
  style?: StyleDesc;
}
export function PromptComposer({
  lifecycle = 'idle',
  style,
  ...props
}: ComposerProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      testId={props.testId ?? `prompt-composer-${lifecycle}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        maxWidth: referenceDark.layout.composerMaximumWidth,
        alignSelf: 'center',
        backgroundColor: theme.colors.raised,
        borderWidth: 1,
        borderColor: lifecycle === 'error' ? theme.colors.danger : theme.colors.border,
        borderRadius: theme.radii.medium,
        ...style,
      }}
    />
  );
}
export function PromptEditorSurface({ style, ...props }: ComposerProps): ReactElement {
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 8,
        paddingLeft: 10,
        paddingRight: 10,
        ...style,
      }}
    />
  );
}
export function ComposerContext({ style, ...props }: ComposerProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        color: theme.colors.muted,
        fontSize: theme.fontSizes.caption,
        ...style,
      }}
    />
  );
}
export function ComposerActions({ style, ...props }: ComposerProps): ReactElement {
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        minHeight: 40,
        padding: 6,
        gap: 6,
        ...style,
      }}
    />
  );
}

export function ComposerSelect({
  value,
  items,
  onValueChange,
  disabled = false,
}: {
  value: string;
  items: Array<{ value: string; label: string }>;
  onValueChange(value: string): void;
  disabled?: boolean;
}): ReactElement {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger style={{ minHeight: 28, borderWidth: 0, backgroundColor: 'transparent' }}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            <text>{item.label}</text>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
