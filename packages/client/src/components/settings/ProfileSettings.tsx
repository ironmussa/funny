import type { UserProfile } from '@funny/shared';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

export function ProfileSettings() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [gitName, setGitName] = useState('');
  const [gitEmail, setGitEmail] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [hasGithubToken, setHasGithubToken] = useState(false);

  useEffect(() => {
    (async () => {
      const result = await api.getProfile();
      if (result.isOk() && result.value) {
        const profile = result.value as UserProfile;
        setGitName(profile.gitName ?? '');
        setGitEmail(profile.gitEmail ?? '');
        setHasGithubToken(profile.hasGithubToken);
      }
      setLoading(false);
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const data: Record<string, string | null | undefined> = {};
    data.gitName = gitName || undefined;
    data.gitEmail = gitEmail || undefined;
    // Only send token if user typed something new
    if (githubToken) {
      data.githubToken = githubToken;
    }
    const result = await api.updateProfile(data as any);
    if (result.isOk()) {
      const profile = result.value;
      setHasGithubToken(profile.hasGithubToken);
      setGithubToken('');
      toast.success(t('profile.saved'));
    } else {
      toast.error(t('profile.saveFailed'));
    }
    setSaving(false);
  };

  const handleClearToken = async () => {
    setSaving(true);
    const result = await api.updateProfile({ githubToken: null });
    if (result.isOk()) {
      setHasGithubToken(false);
      setGithubToken('');
      toast.success(t('profile.tokenCleared'));
    }
    setSaving(false);
  };

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('profile.gitIdentity')}
        </h3>
        <div className="overflow-hidden rounded-lg border border-border/50">
          <div className="border-b border-border/50 px-4 py-3.5">
            <label className="text-sm font-medium text-foreground">{t('profile.gitName')}</label>
            <p className="mb-2 mt-0.5 text-xs text-muted-foreground">{t('profile.gitNameDesc')}</p>
            <Input
              value={gitName}
              onChange={(e) => setGitName(e.target.value)}
              placeholder="John Doe"
            />
          </div>
          <div className="px-4 py-3.5">
            <label className="text-sm font-medium text-foreground">{t('profile.gitEmail')}</label>
            <p className="mb-2 mt-0.5 text-xs text-muted-foreground">{t('profile.gitEmailDesc')}</p>
            <Input
              type="email"
              value={gitEmail}
              onChange={(e) => setGitEmail(e.target.value)}
              placeholder="john@example.com"
            />
          </div>
        </div>
      </div>

      <div>
        <h3 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('profile.githubToken')}
        </h3>
        <div className="overflow-hidden rounded-lg border border-border/50">
          <div className="px-4 py-3.5">
            <label className="text-sm font-medium text-foreground">
              {t('profile.githubTokenLabel')}
            </label>
            <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
              {t('profile.githubTokenDesc')}
            </p>
            <div className="flex items-center gap-2">
              <Input
                type="password"
                value={githubToken}
                onChange={(e) => setGithubToken(e.target.value)}
                placeholder={
                  hasGithubToken ? t('profile.tokenSaved') : t('profile.tokenPlaceholder')
                }
              />
              {hasGithubToken && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-xs text-destructive hover:text-destructive"
                  onClick={handleClearToken}
                  disabled={saving}
                >
                  {t('profile.clearToken')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <Button onClick={handleSave} disabled={saving}>
        {saving ? t('profile.saving') : t('common.save')}
      </Button>
    </div>
  );
}
