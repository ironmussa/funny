import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { SettingRow } from '@/components/settings/SettingRow';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  playNotificationSound,
  showAgentNotification,
  useNotifications,
} from '@/hooks/use-notifications';
import { changeLanguage, SUPPORTED_LANGUAGES } from '@/i18n/config';
import { disableWebPush } from '@/lib/web-push';
import {
  editorLabels,
  type Editor,
  type TerminalShell,
  useSettingsStore,
} from '@/stores/settings-store';

import { toastSettingsSaved } from './preferences-hooks';

const displayNamesCache = new Map<string, Intl.DisplayNames>();

function getDisplayNames(code: string): Intl.DisplayNames {
  let dn = displayNamesCache.get(code);
  if (!dn) {
    dn = new Intl.DisplayNames([code], { type: 'language' });
    displayNamesCache.set(code, dn);
  }
  return dn;
}

function getLanguageName(code: string): string {
  try {
    const name = getDisplayNames(code).of(code);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

// ── Editor + language + shell ────────────────────────────────────────

function EditorRows() {
  const { t } = useTranslation();
  const { defaultEditor, useInternalEditor, setDefaultEditor, setUseInternalEditor } =
    useSettingsStore(
      useShallow((s) => ({
        defaultEditor: s.defaultEditor,
        useInternalEditor: s.useInternalEditor,
        setDefaultEditor: s.setDefaultEditor,
        setUseInternalEditor: s.setUseInternalEditor,
      })),
    );

  const handleEditorChange = useCallback(
    (v: string) => {
      setDefaultEditor(v as Editor);
      toastSettingsSaved(t);
    },
    [setDefaultEditor, t],
  );

  const handleInternalEditorChange = useCallback(
    (checked: boolean) => {
      setUseInternalEditor(checked);
      toastSettingsSaved(t);
    },
    [setUseInternalEditor, t],
  );

  return (
    <>
      <SettingRow title={t('settings.defaultEditor')} description={t('settings.defaultEditorDesc')}>
        <Select value={defaultEditor} onValueChange={handleEditorChange}>
          <SelectTrigger className="w-[140px]" data-testid="preferences-editor-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.entries(editorLabels) as [Editor, string][]).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title={t('settings.useInternalEditor')}
        description={t('settings.useInternalEditorDesc')}
      >
        <Checkbox
          checked={useInternalEditor}
          onCheckedChange={(checked) => handleInternalEditorChange(!!checked)}
          data-testid="preferences-internal-editor"
        />
      </SettingRow>
    </>
  );
}

function LanguageRow() {
  const { t, i18n } = useTranslation();

  const handleLanguageChange = useCallback(
    (code: string) => {
      void changeLanguage(code).then(() => toastSettingsSaved(t));
    },
    [t],
  );

  return (
    <SettingRow title={t('settings.language')} description={t('settings.languageDesc')}>
      <Select value={i18n.language} onValueChange={handleLanguageChange}>
        <SelectTrigger className="w-[140px]" data-testid="preferences-language-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SUPPORTED_LANGUAGES.map((code) => (
            <SelectItem key={code} value={code}>
              {getLanguageName(code)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

function ShellRow() {
  const { t } = useTranslation();
  const { terminalShell, availableShells, setTerminalShell } = useSettingsStore(
    useShallow((s) => ({
      terminalShell: s.terminalShell,
      availableShells: s.availableShells,
      setTerminalShell: s.setTerminalShell,
    })),
  );

  const handleShellChange = useCallback(
    (v: string) => {
      setTerminalShell(v as TerminalShell);
      toastSettingsSaved(t);
    },
    [setTerminalShell, t],
  );

  return (
    <SettingRow title={t('settings.terminalShell')} description={t('settings.terminalShellDesc')}>
      <Select value={terminalShell} onValueChange={handleShellChange}>
        <SelectTrigger className="w-[160px]" data-testid="preferences-shell-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">{t('settings.shellDefault')}</SelectItem>
          {availableShells.map((shell) => (
            <SelectItem key={shell.id} value={shell.id}>
              {shell.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

// ── Notifications ────────────────────────────────────────────────────

type NotificationsApi = ReturnType<typeof useNotifications>;

/** Resolves to true when notifications are (or just became) permitted. */
async function ensureNotificationPermission(notifications: NotificationsApi): Promise<boolean> {
  const permission =
    notifications.permission === 'granted' ? 'granted' : await notifications.requestPermission();
  return permission === 'granted';
}

function notificationsDescriptionKey(notifications: NotificationsApi): string {
  if (!notifications.supported) return 'settings.notificationsUnsupported';
  if (notifications.permission === 'denied') return 'settings.notificationsBlocked';
  return 'settings.notificationsDesc';
}

function useNotificationHandlers(notifications: NotificationsApi) {
  const { t } = useTranslation();
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);

  const enableNotifications = async (): Promise<boolean> => {
    if (await ensureNotificationPermission(notifications)) return true;
    toast.error(t('settings.notificationsDenied'));
    setNotificationsEnabled(false);
    return false;
  };

  const disableNotifications = async (): Promise<boolean> => {
    try {
      await disableWebPush();
      return true;
    } catch (error) {
      toast.error(t('settings.notificationsTestFailed', { reason: String(error) }));
      return false;
    }
  };

  const handleNotificationsToggle = async (checked: boolean) => {
    const applied = checked ? await enableNotifications() : await disableNotifications();
    if (!applied) return;
    setNotificationsEnabled(checked);
    toastSettingsSaved(t);
  };

  const handleTestNotification = async () => {
    if (!notifications.supported) {
      toast.error(t('settings.notificationsUnsupported'));
      return;
    }
    if (!(await ensureNotificationPermission(notifications))) {
      toast.error(t('settings.notificationsDenied'));
      return;
    }
    const result = await showAgentNotification(
      t('settings.notificationsTestTitle'),
      t('settings.notificationsTestBody'),
      { force: true },
    );
    if (result.ok) toast.success(t('settings.notificationsTestSent'));
    else toast.error(t('settings.notificationsTestFailed', { reason: result.reason }));
  };

  return { handleNotificationsToggle, handleTestNotification };
}

function NotificationsRow() {
  const { t } = useTranslation();
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const notifications = useNotifications();
  const { handleNotificationsToggle, handleTestNotification } =
    useNotificationHandlers(notifications);
  const granted = notifications.permission === 'granted';
  const blocked = !notifications.supported || notifications.permission === 'denied';

  return (
    <SettingRow
      title={t('settings.notifications')}
      description={t(notificationsDescriptionKey(notifications))}
    >
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleTestNotification}
          disabled={blocked}
          data-testid="preferences-notifications-test"
        >
          {t('settings.notificationsTest')}
        </Button>
        <Checkbox
          checked={notificationsEnabled && granted}
          disabled={blocked}
          onCheckedChange={(checked) => handleNotificationsToggle(!!checked)}
          data-testid="preferences-notifications-toggle"
        />
      </div>
    </SettingRow>
  );
}

function NotificationSoundRow() {
  const { t } = useTranslation();
  const notificationSoundEnabled = useSettingsStore((s) => s.notificationSoundEnabled);
  const setNotificationSoundEnabled = useSettingsStore((s) => s.setNotificationSoundEnabled);

  const handleNotificationSoundToggle = useCallback(
    (checked: boolean) => {
      setNotificationSoundEnabled(checked);
      if (checked) playNotificationSound();
      toastSettingsSaved(t);
    },
    [setNotificationSoundEnabled, t],
  );

  return (
    <SettingRow
      title={t('settings.notificationsSound')}
      description={t('settings.notificationsSoundDesc')}
    >
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => playNotificationSound()}
          data-testid="preferences-notifications-sound-test"
        >
          {t('settings.notificationsTest')}
        </Button>
        <Checkbox
          checked={notificationSoundEnabled}
          onCheckedChange={(checked) => handleNotificationSoundToggle(!!checked)}
          data-testid="preferences-notifications-sound-toggle"
        />
      </div>
    </SettingRow>
  );
}

/** Settings > General: editor, language, shell and notifications. */
export function GeneralPreferencesSection() {
  return (
    <div className="settings-card">
      <EditorRows />
      <LanguageRow />
      <ShellRow />
      <NotificationsRow />
      <NotificationSoundRow />
    </div>
  );
}
