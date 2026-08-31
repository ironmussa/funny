import {
  Select as GpuixSelect,
  SelectContent as GpuixSelectContent,
  SelectGroup,
  SelectItem as GpuixSelectItem,
  SelectLabel as GpuixSelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator as GpuixSelectSeparator,
  SelectTrigger as GpuixSelectTrigger,
  SelectValue,
} from '@gpuix/react/select';
import type {
  SelectContentProps,
  SelectItemProps,
  SelectItemState,
  SelectProps,
  SelectTriggerProps,
} from '@gpuix/react/select';
import type { ComponentProps, ReactElement } from 'react';

import { useGpuixUiTheme } from './theme';

export const Select = GpuixSelect;
export type { SelectProps };
export { SelectGroup, SelectScrollDownButton, SelectScrollUpButton, SelectValue };

type SelectLabelProps = ComponentProps<typeof GpuixSelectLabel>;
type SelectSeparatorProps = ComponentProps<typeof GpuixSelectSeparator>;

export function SelectTrigger({ style, ...props }: SelectTriggerProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <GpuixSelectTrigger
      {...props}
      style={(state) => ({
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        minHeight: 36,
        paddingLeft: 10,
        paddingRight: 10,
        backgroundColor: theme.colors.background,
        color: state.placeholder ? theme.colors.muted : theme.colors.text,
        borderWidth: 1,
        borderColor: state.open ? theme.colors.borderStrong : theme.colors.border,
        borderRadius: theme.radii.medium,
        cursor: state.disabled ? 'not-allowed' : 'pointer',
        opacity: state.disabled ? 0.55 : 1,
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  );
}

export function SelectContent({ style, ...props }: SelectContentProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <GpuixSelectContent
      {...props}
      style={{
        minWidth: 180,
        padding: 5,
        gap: 3,
        backgroundColor: theme.colors.overlay,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radii.medium,
        boxShadow: {
          offsetX: 0,
          offsetY: 8,
          blurRadius: 24,
          spreadRadius: 0,
          color: '#00000066',
        },
        ...style,
      }}
    />
  );
}

export function SelectItem({ style, ...props }: SelectItemProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <GpuixSelectItem
      {...props}
      style={(state: SelectItemState) => ({
        paddingTop: 7,
        paddingBottom: 7,
        paddingLeft: 9,
        paddingRight: 9,
        borderRadius: theme.radii.small,
        backgroundColor: state.highlighted ? theme.colors.raised : theme.colors.overlay,
        color: state.disabled
          ? theme.colors.muted
          : state.selected
            ? theme.colors.accentForeground
            : theme.colors.text,
        cursor: state.disabled ? 'not-allowed' : 'pointer',
        opacity: state.disabled ? 0.55 : 1,
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  );
}

export function SelectLabel({ style, ...props }: SelectLabelProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <GpuixSelectLabel
      {...props}
      style={{
        paddingTop: 6,
        paddingBottom: 4,
        paddingLeft: 9,
        paddingRight: 9,
        color: theme.colors.muted,
        fontSize: theme.fontSizes.caption,
        fontWeight: 'bold',
        ...style,
      }}
    />
  );
}

export function SelectSeparator({ style, ...props }: SelectSeparatorProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <GpuixSelectSeparator
      {...props}
      style={{
        height: 1,
        marginTop: 4,
        marginBottom: 4,
        backgroundColor: theme.colors.border,
        ...style,
      }}
    />
  );
}
