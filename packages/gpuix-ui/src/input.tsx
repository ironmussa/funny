import type { EventPayload, StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement } from 'react';

import { useGpuixUiTheme } from './theme';

type NativeInputProps = JSX.IntrinsicElements['input'];
type NativeTextareaProps = JSX.IntrinsicElements['textarea'];

export function eventValue(event: EventPayload): string {
  return typeof event.value === 'string' ? event.value : '';
}

export interface InputProps extends Omit<NativeInputProps, 'onChange' | 'style'> {
  onChange?: NativeInputProps['onChange'];
  onValueChange?: (value: string) => void;
  style?: StyleDesc;
}

export interface TextareaProps extends Omit<NativeTextareaProps, 'onChange' | 'style'> {
  onChange?: NativeTextareaProps['onChange'];
  onValueChange?: (value: string) => void;
  style?: StyleDesc;
}

function inputStyle(theme: ReturnType<typeof useGpuixUiTheme>, style?: StyleDesc): StyleDesc {
  return {
    width: '100%',
    minHeight: 36,
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 10,
    paddingRight: 10,
    backgroundColor: theme.colors.background,
    color: theme.colors.text,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.medium,
    selectionColor: theme.colors.accent,
    ...style,
  };
}

export function Input({
  onChange,
  onValueChange,
  style,
  tabIndex = 0,
  theme: nativeTheme,
  ...props
}: InputProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <input
      {...props}
      tabIndex={tabIndex}
      style={inputStyle(theme, style)}
      theme={{
        caret: theme.colors.accent,
        ...nativeTheme,
      }}
      onChange={(event) => {
        onChange?.(event);
        onValueChange?.(eventValue(event));
      }}
    />
  );
}

export function Textarea({
  onChange,
  onValueChange,
  style,
  tabIndex = 0,
  theme: nativeTheme,
  ...props
}: TextareaProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <textarea
      {...props}
      tabIndex={tabIndex}
      style={inputStyle(theme, style)}
      theme={{
        caret: theme.colors.accent,
        ...nativeTheme,
      }}
      onChange={(event) => {
        onChange?.(event);
        onValueChange?.(eventValue(event));
      }}
    />
  );
}
