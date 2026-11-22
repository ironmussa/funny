import type React from 'react';

import { cn } from '@/lib/utils';

import type { SettingId } from './settings-index';
import { useSettingDimmed } from './use-settings-filter';

/**
 * Settings primitives that the sidebar filter can find (openspec
 * `settings-filter`). Each takes the element's `settingId` from the static
 * index (`settings-index.ts`), renders it as `data-setting-id` so the filter
 * can scroll to it, and dims itself while the filter does not match it.
 * `settingId={null}` marks an element that is deliberately not indexed.
 */

const DIMMED = 'opacity-50 transition-opacity';

export function SettingRow({
  settingId,
  title,
  description,
  children,
}: {
  settingId: SettingId | null;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const dimmed = useSettingDimmed(settingId);
  return (
    <div className={cn('settings-row', dimmed && DIMMED)} data-setting-id={settingId ?? undefined}>
      <div className="min-w-0">
        <p className="settings-row-title">{title}</p>
        <p className="settings-row-desc">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A settings section header (`settings-section-header`). */
export function SettingsSection({
  settingId,
  className,
  children,
}: {
  settingId: SettingId | null;
  className?: string;
  children: React.ReactNode;
}) {
  const dimmed = useSettingDimmed(settingId);
  return (
    <h3
      className={cn('settings-section-header', className, dimmed && DIMMED)}
      data-setting-id={settingId ?? undefined}
    >
      {children}
    </h3>
  );
}

/**
 * Marks a hand-laid-out setting (one that does not fit `SettingRow`) as an
 * indexed element. Renders a `div` with the given classes.
 */
export function SettingAnchor({
  settingId,
  className,
  children,
  ...rest
}: {
  settingId: SettingId;
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  const dimmed = useSettingDimmed(settingId);
  return (
    <div {...rest} className={cn(className, dimmed && DIMMED)} data-setting-id={settingId}>
      {children}
    </div>
  );
}
