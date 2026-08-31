import type { StyleDesc } from '@gpuix/react';
import type { JSX } from '@gpuix/react/jsx-runtime';
import type { ReactElement } from 'react';

import { useGpuixUiTheme } from './theme';

export const ICON_NAMES = [
  'navigation',
  'back',
  'project',
  'branch',
  'activity',
  'attachment',
  'send',
  'stop',
  'overflow',
  'expand',
  'collapse',
  'chevron-down',
  'check',
  'warning',
  'pin',
  'chat',
  'inbox',
  'watcher',
  'settings',
  'user',
  'plus',
  'circle',
  'circle-check',
  'clock',
  'error',
  'file',
] as const;
export type IconName = (typeof ICON_NAMES)[number];

const paths: Record<IconName, string> = {
  navigation: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  project: '<path d="M3 6h6l2 2h10v10H3z"/>',
  branch:
    '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 7h6a4 4 0 0 1 4 4v-2"/>',
  activity: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  attachment:
    '<path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 1 1-2.8-2.8L15 5.8"/>',
  send: '<path d="m5 12 7-7 7 7M12 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  overflow:
    '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  expand: '<path d="m9 18 6-6-6-6"/>',
  collapse: '<path d="m6 9 6 6 6-6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  warning: '<path d="M12 3 2 21h20L12 3zM12 9v5M12 18h.01"/>',
  pin: '<path d="M12 17v5M7 3h10l-2 5 3 3v2H6v-2l3-3z"/>',
  chat: '<path d="M5 5h14v11H9l-4 4z"/>',
  inbox: '<path d="M4 4h16v16H4zM4 13h5l2 3h2l2-3h5"/>',
  watcher: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2M9 2h6"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  'circle-check': '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v5h5"/>',
};

type NativeSvgProps = JSX.IntrinsicElements['svg'];
export interface IconProps extends Omit<NativeSvgProps, 'source' | 'style'> {
  name: IconName;
  size?: number;
  color?: string;
  style?: StyleDesc;
}

export function iconSource(name: IconName, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

export function Icon({ name, size = 16, color, style, ...props }: IconProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <svg
      {...props}
      source={iconSource(name, color ?? theme.colors.text)}
      style={{ width: size, height: size, flexShrink: 0, ...style }}
    />
  );
}
