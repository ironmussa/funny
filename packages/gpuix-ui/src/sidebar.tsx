import { referenceDark } from '@funny/ui-contracts/tokens';
import type { StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';

import { Icon } from './icon';
import type { IconName } from './icon';
import { NavItem } from './nav-item';
import { useGpuixUiTheme } from './theme';

type DivProps = JSX.IntrinsicElements['div'];
export type ThreadItemStatus =
  | 'idle'
  | 'setting-up'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed';
export interface SidebarProps extends Omit<DivProps, 'style' | 'title'> {
  title?: ReactNode;
  trailing?: ReactNode;
  style?: StyleDesc;
}
export function SidebarSection({
  title,
  trailing,
  style,
  children,
  ...props
}: SidebarProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div {...props} style={{ display: 'flex', flexDirection: 'column', gap: 4, ...style }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: 24,
          paddingLeft: 6,
          paddingRight: 4,
        }}
      >
        <text
          style={{
            color: theme.colors.muted,
            fontSize: theme.fontSizes.caption,
            fontWeight: 'bold',
          }}
        >
          {title}
        </text>
        {trailing}
      </div>
      {children}
    </div>
  );
}

export interface SidebarDisclosureSectionProps extends SidebarProps {
  expanded?: boolean;
  onToggle?: () => void;
}

export function SidebarDisclosureSection({
  title,
  trailing,
  expanded,
  onToggle,
  children,
  style,
  ...props
}: SidebarDisclosureSectionProps): ReactElement {
  const theme = useGpuixUiTheme();
  const [internalExpanded, setInternalExpanded] = useState(true);
  const isExpanded = expanded ?? internalExpanded;
  const toggle = () => {
    if (onToggle) onToggle();
    else setInternalExpanded((current) => !current);
  };
  return (
    <div {...props} style={{ display: 'flex', flexDirection: 'column', gap: 3, ...style }}>
      <NavItem onSelect={toggle} style={{ minHeight: 24, padding: 4 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name={isExpanded ? 'collapse' : 'expand'} size={12} color={theme.colors.muted} />
          <text
            style={{
              color: theme.colors.muted,
              fontSize: theme.fontSizes.caption,
              fontWeight: 'bold',
              flexGrow: 1,
            }}
          >
            {title}
          </text>
          {trailing}
        </div>
      </NavItem>
      {isExpanded ? children : null}
    </div>
  );
}
export interface ProjectGroupProps extends SidebarProps {
  expanded?: boolean;
  onToggle?: () => void;
  icon?: ReactNode;
}
export function ProjectGroup({
  title,
  trailing,
  expanded,
  onToggle,
  icon,
  children,
  style,
  ...props
}: ProjectGroupProps): ReactElement {
  const theme = useGpuixUiTheme();
  const [internalExpanded, setInternalExpanded] = useState(true);
  const isExpanded = expanded ?? internalExpanded;
  const toggle = () => {
    if (onToggle) onToggle();
    else setInternalExpanded((current) => !current);
  };
  return (
    <div {...props} style={{ display: 'flex', flexDirection: 'column', gap: 3, ...style }}>
      <NavItem onSelect={toggle} style={{ minHeight: 28, padding: 5 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Icon name={isExpanded ? 'collapse' : 'expand'} size={13} color={theme.colors.muted} />
          {icon ?? <Icon name="project" size={14} color={theme.colors.muted} />}
          <text style={{ color: theme.colors.text, fontWeight: 'bold', lineClamp: 1, flexGrow: 1 }}>
            {title}
          </text>
        </div>
        {trailing}
      </NavItem>
      {isExpanded ? <div style={{ gap: 2 }}>{children}</div> : null}
    </div>
  );
}
export function StatusPin({
  status = 'idle',
  style,
  ...props
}: { status?: ThreadItemStatus; style?: StyleDesc } & Omit<DivProps, 'style'>): ReactElement {
  const theme = useGpuixUiTheme();
  const color =
    status === 'failed'
      ? theme.colors.danger
      : status === 'running'
        ? theme.colors.success
        : status === 'setting-up'
          ? theme.colors.borderStrong
          : status === 'waiting'
            ? theme.colors.warning
            : status === 'completed'
              ? theme.colors.success
              : theme.colors.muted;
  const iconName: IconName | null =
    status === 'completed'
      ? 'circle-check'
      : status === 'waiting'
        ? 'clock'
        : status === 'failed'
          ? 'error'
          : status === 'idle'
            ? 'circle'
            : null;
  if (iconName)
    return (
      <div {...props} style={{ width: 13, height: 13, flexShrink: 0, ...style }}>
        <Icon name={iconName} size={13} color={color} />
      </div>
    );
  return (
    <div
      {...props}
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        backgroundColor: color,
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
export function MetaChip({
  children,
  style,
  ...props
}: Omit<DivProps, 'style'> & { style?: StyleDesc }): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingTop: 2,
        paddingBottom: 2,
        paddingLeft: 5,
        paddingRight: 5,
        borderRadius: theme.radii.small,
        backgroundColor: theme.colors.raised,
        color: theme.colors.muted,
        fontSize: theme.fontSizes.caption,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
export interface ThreadListItemProps extends Omit<DivProps, 'style' | 'title'> {
  title: ReactNode;
  metadata?: ReactNode;
  time?: ReactNode;
  marker?: ReactNode;
  selected?: boolean;
  status?: ThreadItemStatus;
  onSelect(): void;
  style?: StyleDesc;
}
export function ThreadListItem({
  title,
  metadata,
  time,
  marker,
  selected = false,
  status = 'idle',
  onSelect,
  style,
  ...props
}: ThreadListItemProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <NavItem
      {...props}
      selected={selected}
      onSelect={onSelect}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 38,
        paddingTop: 5,
        paddingBottom: 5,
        paddingLeft: 8,
        paddingRight: 8,
        backgroundColor: selected ? theme.colors.raised : theme.colors.panel,
        borderColor: selected ? theme.colors.raised : theme.colors.panel,
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          width: '100%',
          gap: 7,
        }}
      >
        {marker ?? <StatusPin status={status} />}
        <text style={{ color: theme.colors.text, flexGrow: 1, minWidth: 0, lineClamp: 1 }}>
          {title}
        </text>
        {time ? (
          <text style={{ color: theme.colors.muted, fontSize: theme.fontSizes.caption }}>
            {time}
          </text>
        ) : null}
      </div>
      {metadata ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            paddingLeft: 14,
            minWidth: 0,
            color: theme.colors.muted,
            fontSize: theme.fontSizes.caption,
          }}
        >
          {metadata}
        </div>
      ) : null}
    </NavItem>
  );
}
export function SidebarShell({
  style,
  ...props
}: Omit<DivProps, 'style'> & { style?: StyleDesc }): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: referenceDark.layout.sidebarWidth,
        minWidth: referenceDark.layout.sidebarMinimumWidth,
        minHeight: 0,
        height: '100%',
        paddingTop: 8,
        backgroundColor: theme.colors.panel,
        borderRightWidth: 1,
        borderColor: theme.colors.border,
        ...style,
      }}
    />
  );
}

export function SidebarBody({
  style,
  ...props
}: Omit<DivProps, 'style'> & { style?: StyleDesc }): ReactElement {
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minHeight: 0,
        paddingLeft: 6,
        paddingRight: 6,
        ...style,
      }}
    />
  );
}

export function SidebarFooter({
  style,
  ...props
}: Omit<DivProps, 'style'> & { style?: StyleDesc }): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        gap: 2,
        padding: 8,
        borderTopWidth: 1,
        borderColor: theme.colors.border,
        ...style,
      }}
    />
  );
}

export function SidebarAction({
  icon,
  label,
  trailing,
  onSelect,
  style,
  ...props
}: Omit<DivProps, 'style' | 'title'> & {
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  onSelect(): void;
  style?: StyleDesc;
}): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <NavItem {...props} onSelect={onSelect} style={{ minHeight: 30, padding: 6, ...style }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {icon}
        <text style={{ color: theme.colors.text, flexGrow: 1, minWidth: 0, lineClamp: 1 }}>
          {label}
        </text>
        {trailing}
      </div>
    </NavItem>
  );
}

export function SidebarProfile({
  name,
  username,
  action,
  style,
  ...props
}: Omit<DivProps, 'style' | 'title'> & {
  name: string;
  username?: string;
  action?: ReactNode;
  style?: StyleDesc;
}): ReactElement {
  const theme = useGpuixUiTheme();
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div
      {...props}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 34,
        gap: 8,
        padding: 4,
        ...style,
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 999,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.success,
        }}
      >
        <text style={{ color: theme.colors.background, fontWeight: 'bold', fontSize: 11 }}>
          {initials || '?'}
        </text>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1 }}>
        <text style={{ color: theme.colors.text, lineClamp: 1 }}>{name}</text>
        {username ? (
          <text style={{ color: theme.colors.muted, fontSize: theme.fontSizes.caption }}>
            @{username}
          </text>
        ) : null}
      </div>
      {action}
    </div>
  );
}
