import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { showAgentNotification, useNotifications } from '@/hooks/use-notifications';
import { useSettingsStore } from '@/stores/settings-store';

export function MobileNotifications() {
  const { t } = useTranslation();
  const { permission, requestPermission, supported } = useNotifications();
  const enabled = useSettingsStore((s) => s.notificationsEnabled);
  const setEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const [busy, setBusy] = useState(false);

  async function toggle(checked: boolean) {
    setBusy(true);
    try {
      if (checked && (await requestPermission()) !== 'granted') {
        toast.error(t('settings.notificationsDenied'));
        setEnabled(false);
        return;
      }
      setEnabled(checked);
    } catch {
      toast.error(t('settings.notificationsDenied'));
    } finally {
      setBusy(false);
    }
  }

  async function testNotification() {
    setBusy(true);
    try {
      const result = await showAgentNotification(
        t('settings.notificationsTestTitle'),
        t('settings.notificationsTestBody'),
        { force: true },
      );
      if (result.ok) toast.success(t('settings.notificationsTestSent'));
      else toast.error(t('settings.notificationsTestFailed', { reason: result.reason }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-border space-y-2 border-b px-4 py-3">
      <div className="flex items-center gap-3">
        <label htmlFor="mobile-notifications" className="flex-1 text-sm font-medium">
          {t('settings.notifications')}
        </label>
        <Switch
          id="mobile-notifications"
          checked={enabled && permission === 'granted'}
          disabled={busy || !supported || permission === 'denied'}
          onCheckedChange={toggle}
        />
        {enabled && permission === 'granted' && (
          <Button variant="outline" size="sm" disabled={busy} onClick={testNotification}>
            {t('settings.notificationsTest')}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {t(
          !supported
            ? 'settings.notificationsMobileUnsupported'
            : permission === 'denied'
              ? 'settings.notificationsBlocked'
              : 'settings.notificationsMobileDesc',
        )}
      </p>
    </section>
  );
}
