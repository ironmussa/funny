import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

import { SettingRow } from './SettingRow';

interface TeamSettingsData {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  hasApiKey: boolean;
  defaultModel: string | null;
  defaultMode: string | null;
  defaultPermissionMode: string | null;
}

export function TeamSettings() {
  const { t: _t } = useTranslation();
  const [settings, setSettings] = useState<TeamSettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getTeamSettings().then((result) => {
      if (result.isOk()) {
        setSettings(result.value);
      }
      setLoading(false);
    });
  }, []);

  const handleSaveApiKey = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    const result = await api.updateTeamApiKey(apiKey.trim());
    if (result.isOk()) {
      setSettings((prev) => (prev ? { ...prev, hasApiKey: result.value.hasApiKey } : prev));
      setApiKey('');
      toast.success('API key saved');
    } else {
      toast.error('Failed to save API key');
    }
    setSaving(false);
  }, [apiKey]);

  const handleClearApiKey = useCallback(async () => {
    setSaving(true);
    const result = await api.updateTeamApiKey(null);
    if (result.isOk()) {
      setSettings((prev) => (prev ? { ...prev, hasApiKey: false } : prev));
      toast.success('API key cleared');
    } else {
      toast.error('Failed to clear API key');
    }
    setSaving(false);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Loading team settings...
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        No active organization. Join or create an organization to configure team settings.
      </div>
    );
  }

  return (
    <>
      {/* General */}
      <h3 className="settings-section-header">Organization</h3>
      <div className="settings-card">
        <SettingRow title="Name" description="Your organization's display name">
          <span className="text-sm text-foreground" data-testid="team-settings-name">
            {settings.name}
          </span>
        </SettingRow>
        <SettingRow title="Slug" description="URL-safe identifier">
          <span
            className="font-mono text-sm text-muted-foreground"
            data-testid="team-settings-slug"
          >
            {settings.slug}
          </span>
        </SettingRow>
      </div>

      {/* API Key */}
      <h3 className="settings-section-header">Anthropic API Key</h3>
      <div className="settings-card">
        <div className="px-4 py-3.5">
          <p className="settings-row-title">Team API Key</p>
          <p className="settings-row-desc mb-3">
            Shared API key used for all team members. Encrypted at rest.
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings.hasApiKey ? 'Key saved (enter new to replace)' : 'sk-ant-...'}
              className="text-sm"
              data-testid="team-settings-api-key-input"
            />
            <Button
              size="sm"
              onClick={handleSaveApiKey}
              disabled={!apiKey.trim() || saving}
              data-testid="team-settings-api-key-save"
            >
              Save
            </Button>
            {settings.hasApiKey && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-xs text-destructive hover:text-destructive"
                onClick={handleClearApiKey}
                disabled={saving}
                data-testid="team-settings-api-key-clear"
              >
                Clear
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
