import type { ToolPermission } from '@funny/shared';
import { RotateCcw } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { SegmentedControl } from '@/components/general-settings-project/setting-primitives';
import { SettingAnchor, SettingsSection } from '@/components/settings/SettingRow';
import { toast } from '@/components/ui/toast';
import { ALL_STANDARD_TOOLS, TOOL_LABELS, useSettingsStore } from '@/stores/settings-store';

/** Per-tool allow / ask / deny permissions, with a reset to the defaults. */
export function ToolPermissionsSection() {
  const { toolPermissions, setToolPermission, resetToolPermissions } = useSettingsStore(
    useShallow((s) => ({
      toolPermissions: s.toolPermissions,
      setToolPermission: s.setToolPermission,
      resetToolPermissions: s.resetToolPermissions,
    })),
  );
  const { t } = useTranslation();

  const saveToolPermission = useCallback(
    (toolName: string, permission: ToolPermission) => {
      setToolPermission(toolName, permission);
      toast.success(t('settings.saved'), { id: 'settings-saved' });
    },
    [setToolPermission, t],
  );

  const saveResetToolPermissions = useCallback(() => {
    resetToolPermissions();
    toast.success(t('settings.saved'), { id: 'settings-saved' });
  }, [resetToolPermissions, t]);

  return (
    <>
      <SettingsSection settingId="project-general.permissions" className="mt-6">
        {t('settings.permissions')}
      </SettingsSection>
      <div className="border-border/50 overflow-hidden rounded-lg border">
        <SettingAnchor settingId="project-general.tool-permissions" className="px-4 py-3.5">
          <p className="text-foreground text-sm font-medium">{t('settings.toolPermissions')}</p>
          <p className="text-muted-foreground mt-0.5 mb-3 text-xs">
            {t('settings.toolPermissionsDesc')}
          </p>
          <div className="space-y-1">
            {ALL_STANDARD_TOOLS.map((tool) => (
              <div
                key={tool}
                className="hover:bg-muted/50 flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-foreground font-mono text-sm">{tool}</span>
                  <span className="text-muted-foreground text-xs">
                    {t(TOOL_LABELS[tool] ?? tool)}
                  </span>
                </div>
                <SegmentedControl<ToolPermission>
                  value={toolPermissions[tool] ?? 'allow'}
                  onChange={(v) => saveToolPermission(tool, v)}
                  options={[
                    { value: 'allow', label: t('settings.allow') },
                    { value: 'ask', label: t('settings.ask') },
                    { value: 'deny', label: t('settings.deny') },
                  ]}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => saveResetToolPermissions()}
              data-testid="settings-reset-defaults"
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors"
            >
              <RotateCcw className="icon-xs" />
              {t('settings.resetDefaults')}
            </button>
          </div>
        </SettingAnchor>
      </div>
    </>
  );
}
