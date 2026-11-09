/**
 * State + auto-save handlers for the preferences pages. Kept as hooks so
 * `PreferencesContent` can own them once (state survives page switches) and
 * hand them to the page sections.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { updateProfile } from '@/data/profile/actions';
import { useProfile } from '@/data/profile/hooks';
import { refreshProfile } from '@/data/profile/queries';
import { api } from '@/lib/api';

/** Toast shown after every auto-saved preference (deduped by id). */
export function toastSettingsSaved(t: (key: string) => string) {
  toast.success(t('settings.saved'), { id: 'settings-saved' });
}

// ── Provider keys (GitHub token, AI provider keys, AssemblyAI) ────────

type KeyMap<T> = Record<string, T>;

const NO_KEYS: KeyMap<boolean> = {};

/** Updater that sets one provider id in a per-key map. */
function withKey<T>(id: string, value: T) {
  return (prev: KeyMap<T>): KeyMap<T> => ({ ...prev, [id]: value });
}

export function useProviderKeys() {
  const { t } = useTranslation();
  const [keyInputs, setKeyInputs] = useState<KeyMap<string>>({});
  const [keySaving, setKeySaving] = useState<KeyMap<boolean>>({});
  // Saved writes update the profile query, so presence follows them.
  const keyPresence = useProfile()?.providerKeys ?? NO_KEYS;

  // Opening the settings page reads a fresh profile (keys may have changed elsewhere).
  useEffect(() => {
    void refreshProfile();
  }, []);

  const handleSave = useCallback(
    async (id: string) => {
      const value = keyInputs[id];
      if (!value) return;
      setKeySaving(withKey(id, true));
      const result = await updateProfile({ providerKey: { id, value } });
      if (result.isOk()) {
        setKeyInputs(withKey(id, ''));
        toast.success(t('profile.tokenSaved'));
      } else {
        toast.error(t('profile.saveFailed'));
      }
      setKeySaving(withKey(id, false));
    },
    [keyInputs, t],
  );

  const handleClear = useCallback(
    async (id: string) => {
      setKeySaving(withKey(id, true));
      const result = await updateProfile({ providerKey: { id, value: null } });
      if (result.isOk()) {
        setKeyInputs(withKey(id, ''));
        toast.success(t('profile.tokenCleared'));
      }
      setKeySaving(withKey(id, false));
    },
    [t],
  );

  return { keyInputs, keyPresence, keySaving, setKeyInputs, handleSave, handleClear };
}

export type ProviderKeysState = ReturnType<typeof useProviderKeys>;

// ── SMTP ──────────────────────────────────────────────────────────────

export type SmtpSource = 'database' | 'environment' | 'none';

export function useSmtpSettings() {
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpHasPassword, setSmtpHasPassword] = useState(false);
  const [smtpSource, setSmtpSource] = useState<SmtpSource>('none');
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpTesting, setSmtpTesting] = useState(false);

  useEffect(() => {
    api.getSmtpSettings().then((result) => {
      if (!result.isOk()) return;
      setSmtpHost(result.value.host);
      setSmtpPort(result.value.port);
      setSmtpUser(result.value.user);
      setSmtpFrom(result.value.from);
      setSmtpHasPassword(result.value.hasPassword);
      setSmtpSource(result.value.source);
    });
  }, []);

  const handleSaveSmtp = useCallback(async () => {
    setSmtpSaving(true);
    try {
      const result = await api.updateSmtpSettings({
        host: smtpHost,
        port: smtpPort,
        user: smtpUser,
        pass: smtpPass || undefined,
        from: smtpFrom,
      });
      if (result.isOk()) {
        toast.success('SMTP settings saved');
        if (smtpPass) setSmtpHasPassword(true);
        setSmtpSource('database');
        setSmtpPass('');
      } else {
        toast.error('Failed to save SMTP settings');
      }
    } finally {
      setSmtpSaving(false);
    }
  }, [smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom]);

  const handleTestSmtp = useCallback(async () => {
    setSmtpTesting(true);
    try {
      const result = await api.testSmtpSettings();
      if (result.isOk()) {
        toast.success(`Test email sent to ${result.value.sentTo}`);
      } else {
        toast.error('Failed to send test email. Check your SMTP settings.');
      }
    } finally {
      setSmtpTesting(false);
    }
  }, []);

  return {
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    smtpFrom,
    smtpHasPassword,
    smtpSource,
    smtpSaving,
    smtpTesting,
    setSmtpHost,
    setSmtpPort,
    setSmtpUser,
    setSmtpPass,
    setSmtpFrom,
    handleSaveSmtp,
    handleTestSmtp,
  };
}
