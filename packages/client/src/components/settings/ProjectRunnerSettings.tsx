import type { ProjectRunnerSettingsResponse, RunnerInfo } from '@funny/shared/runner-protocol';
import { AlertTriangle, KeyRound, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';

const GENERAL_VALUE = '__general__';
const NONE_VALUE = '__none__';

/**
 * Project → runner binding (project-runner-binding). The project runs on the
 * owner's general runner unless pinned to a dedicated one; extra runners need
 * an explicit grant. A project may also carry its own GitHub token.
 */
export function ProjectRunnerSettings() {
  const { t } = useTranslation();
  const projectId = useProjectStore((s) => s.selectedProjectId);
  const [settings, setSettings] = useState<ProjectRunnerSettingsResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');

  const load = useCallback(async () => {
    if (!projectId) return;
    const result = await api.getProjectRunnerSettings(projectId);
    if (result.isErr()) {
      toast.error(t('projectRunner.loadError', 'Failed to load runner settings'), {
        description: result.error.message,
      });
      return;
    }
    setSettings(result.value);
  }, [projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    async (
      action: () => ReturnType<typeof api.getProjectRunnerSettings>,
      successMessage: string,
    ) => {
      setSaving(true);
      try {
        const result = await action();
        if (result.isErr()) {
          toast.error(t('projectRunner.saveError', 'Failed to save runner settings'), {
            description: result.error.message,
          });
          return;
        }
        setSettings((current) => ({ ...current, ...result.value }));
        toast.success(successMessage);
      } finally {
        setSaving(false);
      }
    },
    [t],
  );

  if (!projectId || !settings) {
    return (
      <div className="text-muted-foreground py-6 text-center text-sm">
        {t('common.loading', 'Loading…')}
      </div>
    );
  }

  const runners = settings.runners ?? [];
  const dedicated = runners.find((r) => r.runnerId === settings.dedicatedRunnerId);
  const pinnedOffline = !!settings.dedicatedRunnerId && dedicated?.status !== 'online';
  const grantable = runners.filter((r) => r.runnerId !== settings.dedicatedRunnerId);

  const changeDedicated = (value: string) =>
    apply(
      () =>
        api.updateProjectRunnerSettings(projectId, {
          dedicatedRunnerId: value === GENERAL_VALUE ? null : value,
        }),
      t('projectRunner.saved', 'Runner settings saved'),
    );

  const toggleGrant = (runnerId: string, granted: boolean) =>
    apply(
      () =>
        granted
          ? api.grantProjectRunner(projectId, runnerId)
          : api.revokeProjectRunner(projectId, runnerId),
      t('projectRunner.saved', 'Runner settings saved'),
    );

  const changeGeneral = async (value: string) => {
    setSaving(true);
    try {
      const result = await api.setGeneralRunner(value === NONE_VALUE ? null : value);
      if (result.isErr()) {
        toast.error(t('projectRunner.saveError', 'Failed to save runner settings'), {
          description: result.error.message,
        });
        return;
      }
      setSettings((current) =>
        current ? { ...current, generalRunnerId: result.value.generalRunnerId } : current,
      );
      toast.success(t('projectRunner.saved', 'Runner settings saved'));
    } finally {
      setSaving(false);
    }
  };

  const saveToken = (token: string | null) =>
    apply(
      () => api.updateProjectRunnerSettings(projectId, { githubToken: token }),
      token
        ? t('projectRunner.tokenSaved', 'Project GitHub token saved')
        : t('projectRunner.tokenCleared', 'Project GitHub token removed'),
    ).then(() => setTokenDraft(''));

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">
            {t('projectRunner.runnerTitle', 'Runner for this project')}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t(
              'projectRunner.runnerDesc',
              'A dedicated runner serves only this project. If it is offline, requests fail instead of falling back to another runner.',
            )}
          </p>
        </div>
        <div className="border-border/50 space-y-3 rounded-lg border p-4">
          <Select
            value={settings.dedicatedRunnerId ?? GENERAL_VALUE}
            onValueChange={changeDedicated}
            disabled={saving}
          >
            <SelectTrigger
              className="w-full max-w-md"
              data-testid="project-runner-dedicated-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={GENERAL_VALUE}>
                {t('projectRunner.useGeneral', 'Use my general runner')}
              </SelectItem>
              {runners.map((runner) => (
                <SelectItem key={runner.runnerId} value={runner.runnerId}>
                  <RunnerLabel runner={runner} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {pinnedOffline && (
            <Alert variant="destructive" data-testid="project-runner-offline-alert">
              <AlertTriangle className="icon-sm" />
              <AlertDescription>
                {t(
                  'projectRunner.dedicatedOffline',
                  "This project's runner is offline. Agents for this project will not run until it reconnects.",
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>
      </section>

      {settings.dedicatedRunnerId && grantable.length > 0 && (
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">
              {t('projectRunner.grantsTitle', 'Other runners with access')}
            </h3>
            <p className="text-muted-foreground text-xs">
              {t(
                'projectRunner.grantsDesc',
                'Only runners enabled here may serve this project besides its dedicated runner.',
              )}
            </p>
          </div>
          <div className="border-border/50 divide-border/50 divide-y rounded-lg border">
            {grantable.map((runner) => (
              <label
                key={runner.runnerId}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <RunnerLabel runner={runner} />
                <Switch
                  checked={settings.grantedRunnerIds.includes(runner.runnerId)}
                  onCheckedChange={(checked) => toggleGrant(runner.runnerId, checked)}
                  disabled={saving}
                  data-testid={`project-runner-grant-${runner.runnerId}`}
                />
              </label>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">
            {t('projectRunner.generalTitle', 'Your general runner')}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t(
              'projectRunner.generalDesc',
              'Applies to all your projects: it serves scratch threads, folder browsing and every project without a dedicated runner.',
            )}
          </p>
        </div>
        <div className="border-border/50 rounded-lg border p-4">
          <Select
            value={settings.generalRunnerId ?? NONE_VALUE}
            onValueChange={changeGeneral}
            disabled={saving}
          >
            <SelectTrigger className="w-full max-w-md" data-testid="project-runner-general-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>
                {t('projectRunner.anyGeneral', 'Any of my general runners')}
              </SelectItem>
              {runners.map((runner) => (
                <SelectItem key={runner.runnerId} value={runner.runnerId}>
                  <RunnerLabel runner={runner} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">
            {t('projectRunner.gitTitle', 'Git credentials')}
          </h3>
          <p className="text-muted-foreground text-xs">
            {settings.hasGithubToken
              ? t('projectRunner.tokenSet', 'This project uses its own GitHub token.')
              : t(
                  'projectRunner.tokenInherited',
                  'This project uses your personal GitHub token from your profile.',
                )}
          </p>
        </div>
        {settings.dedicatedRunnerId && !settings.hasGithubToken && (
          <Alert data-testid="project-runner-personal-token-warning">
            <KeyRound className="icon-sm" />
            <AlertDescription>
              {t(
                'projectRunner.personalTokenWarning',
                'The dedicated runner uses your personal GitHub token, which can reach all your repositories. Consider a fine-grained token limited to this repository.',
              )}
            </AlertDescription>
          </Alert>
        )}
        <div className="border-border/50 flex flex-wrap items-center gap-2 rounded-lg border p-4">
          <Input
            type="password"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder={t('projectRunner.tokenPlaceholder', 'github_pat_…')}
            className={cn('max-w-md flex-1 font-mono')}
            autoComplete="off"
            data-testid="project-runner-github-token"
          />
          <Button
            size="sm"
            onClick={() => saveToken(tokenDraft.trim())}
            disabled={saving || !tokenDraft.trim()}
            data-testid="project-runner-github-token-save"
          >
            <Save className="icon-sm mr-1.5" />
            {t('common.save', 'Save')}
          </Button>
          {settings.hasGithubToken && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => saveToken(null)}
              disabled={saving}
              data-testid="project-runner-github-token-clear"
            >
              <Trash2 className="icon-sm mr-1.5" />
              {t('projectRunner.useProfileToken', 'Use my personal token')}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}

function RunnerLabel({ runner }: { runner: RunnerInfo }) {
  const { t } = useTranslation();
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          runner.status === 'online' ? 'bg-status-success' : 'bg-muted-foreground/40',
        )}
      />
      <span className="truncate">{runner.name}</span>
      <Badge variant="outline" size="xs">
        {runner.role === 'dedicated'
          ? t('projectRunner.roleDedicated', 'dedicated')
          : t('projectRunner.roleGeneral', 'general')}
      </Badge>
    </span>
  );
}
