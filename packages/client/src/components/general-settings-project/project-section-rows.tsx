import type { WeaveStatus } from '@funny/shared';
import { MessageSquareText, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { projectsApi } from '@/lib/api/projects';
import { cn } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';

import { SettingRow } from './setting-primitives';

/* ── URL patterns for Chrome extension auto-detection ── */
export function ProjectUrlPatterns({
  projectId,
  currentUrls,
  onSave,
}: {
  projectId: string;
  currentUrls: string[];
  onSave: (projectId: string, data: { urls: string[] | null }) => void;
}) {
  const [urlRows, setUrlRows] = useState(() =>
    currentUrls.map((value, index) => ({ id: `initial:${index}`, value })),
  );
  const nextAddedUrlIdRef = useRef(0);
  const [lastSeenUrls, setLastSeenUrls] = useState(currentUrls);
  const { t } = useTranslation();

  // Reset local edits when the parent passes a new currentUrls reference.
  if (currentUrls !== lastSeenUrls) {
    setLastSeenUrls(currentUrls);
    setUrlRows(currentUrls.map((value, index) => ({ id: `external:${index}`, value })));
  }

  const save = (newRows: typeof urlRows) => {
    const filtered = newRows.filter((row) => row.value.trim() !== '');
    setUrlRows(filtered);
    onSave(projectId, {
      urls: filtered.length > 0 ? filtered.map((row) => row.value) : null,
    });
  };

  return (
    <div className="border-border/50 flex flex-col gap-3 border-b px-4 py-3.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">
          {t('settings.projectUrls', 'Extension URLs')}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {t(
            'settings.projectUrlsDesc',
            'URLs for Chrome extension auto-detection. The extension will auto-select this project when you visit a matching URL.',
          )}
        </p>
      </div>
      <div className="space-y-2">
        {urlRows.map((row, i) => (
          <div key={row.id} className="flex items-center gap-2">
            <Input
              value={row.value}
              onChange={(e) => {
                const next = [...urlRows];
                next[i] = { ...row, value: e.target.value };
                setUrlRows(next);
              }}
              onBlur={() => save(urlRows)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') save(urlRows);
              }}
              placeholder="https://example.com"
              className="h-8 flex-1 font-mono text-xs"
            />
            <TooltipIconButton
              size="icon-sm"
              className="shrink-0"
              onClick={() => {
                const next = urlRows.filter((_, idx) => idx !== i);
                save(next);
              }}
              tooltip={t('common.delete')}
            >
              <X className="icon-sm" />
            </TooltipIconButton>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const id = `added:${nextAddedUrlIdRef.current++}`;
            setUrlRows((prev) => [...prev, { id, value: '' }]);
          }}
          data-testid="settings-url-pattern-add"
        >
          <Plus className="icon-xs mr-1.5" />
          {t('settings.addUrl', 'Add URL')}
        </Button>
      </div>
    </div>
  );
}

/* ── Project system prompt ── */
export function ProjectSystemPrompt({
  projectId,
  currentPrompt,
  onSave,
}: {
  projectId: string;
  currentPrompt?: string;
  onSave: (projectId: string, data: { systemPrompt: string | null }) => void;
}) {
  const [value, setValue] = useState(currentPrompt || '');
  const { t } = useTranslation();

  useEffect(() => {
    setValue(currentPrompt || '');
  }, [currentPrompt]);

  const save = () => {
    const trimmed = value.trim();
    onSave(projectId, { systemPrompt: trimmed || null });
  };

  return (
    <div className="border-border/50 flex flex-col gap-3 border-b px-4 py-3.5 last:border-b-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <MessageSquareText className="icon-base text-muted-foreground" />
          <p className="text-foreground text-sm font-medium">
            {t('settings.systemPrompt', 'System Prompt')}
          </p>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {t(
            'settings.systemPromptDesc',
            'Custom instructions prepended to every agent message in this project. Use this for project-specific conventions, coding standards, or context.',
          )}
        </p>
      </div>
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        placeholder={t(
          'settings.systemPromptPlaceholder',
          "e.g. Always use TypeScript strict mode. Follow the repository's existing patterns...",
        )}
        className="min-h-[120px] resize-y font-mono text-xs"
        data-testid="settings-system-prompt"
      />
    </div>
  );
}

/* ── Podman launcher URL ── */
export function LauncherUrlSetting({
  projectId,
  currentUrl,
  onSave,
}: {
  projectId: string;
  currentUrl?: string;
  onSave: (projectId: string, data: { launcherUrl: string | null }) => void;
}) {
  const [value, setValue] = useState(currentUrl || '');
  const { t } = useTranslation();

  useEffect(() => {
    setValue(currentUrl || '');
  }, [currentUrl]);

  const save = () => {
    const trimmed = value.trim();
    onSave(projectId, { launcherUrl: trimmed || null });
  };

  return (
    <SettingRow
      title={t('settings.launcherUrl', 'Podman Launcher URL')}
      description={t(
        'settings.launcherUrlDesc',
        'URL of the Podman launcher API for remote container execution',
      )}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') save();
        }}
        placeholder="http://localhost:4040"
        className="h-8 w-[240px] font-mono text-xs"
        data-testid="settings-launcher-url"
      />
    </SettingRow>
  );
}

/* ── Default Deep Agent template ── */
export function DefaultTemplateSetting({
  projectId,
  currentTemplateId,
  onSave,
}: {
  projectId: string;
  currentTemplateId?: string;
  onSave: (id: string, data: Record<string, unknown>) => void;
}) {
  const { templates, initialized, loadTemplates } = useAgentTemplateStore();

  useEffect(() => {
    if (!initialized) loadTemplates();
  }, [initialized, loadTemplates]);

  return (
    <SettingRow
      title="Default Agent Template"
      description="Auto-select this template when creating new Deep Agent threads in this project."
    >
      <select
        aria-label="Default agent template"
        className="border-input bg-background h-9 rounded-md border px-3 text-xs"
        value={currentTemplateId ?? ''}
        onChange={(e) => {
          const val = e.target.value || null;
          onSave(projectId, { defaultAgentTemplateId: val });
        }}
        data-testid="settings-default-agent-template"
      >
        <option value="">None</option>
        {templates.map((tpl) => (
          <option key={tpl.id} value={tpl.id}>
            {tpl.id.startsWith('__builtin__') ? `[Built-in] ${tpl.name}` : tpl.name}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

/* ── Weave semantic merge status ── */
export function WeaveStatusSetting({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<WeaveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [configuring, setConfiguring] = useState(false);
  const { t } = useTranslation();

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const result = await projectsApi.getWeaveStatus(projectId);
      setStatus(result.isOk() ? result.value : null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleConfigure = async () => {
    setConfiguring(true);
    const result = await projectsApi.configureWeave(projectId);
    if (result.isOk()) {
      setStatus(result.value.status);
      toast.success(t('settings.weaveConfigured', 'Weave semantic merge configured'));
    } else {
      toast.error(t('settings.weaveConfigureFailed', 'Failed to configure Weave'));
    }
    setConfiguring(false);
  };

  if (loading) {
    return (
      <SettingRow
        title={t('settings.weaveTitle', 'Semantic Merge (Weave)')}
        description={t(
          'settings.weaveDesc',
          'Reduces false merge conflicts using semantic analysis',
        )}
      >
        <div className="bg-muted h-8 w-[140px] rounded-md" />
      </SettingRow>
    );
  }

  if (!status || status.status === 'not-installed') {
    return (
      <SettingRow
        title={t('settings.weaveTitle', 'Semantic Merge (Weave)')}
        description={t(
          'settings.weaveDesc',
          'Reduces false merge conflicts using semantic analysis',
        )}
      >
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <span data-testid="settings-weave-status">
            {t('settings.weaveNotInstalled', 'weave-driver not found')}
          </span>
          <a
            href="https://github.com/Ataraxy-Labs/weave"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-500 hover:underline"
            data-testid="settings-weave-install-link"
          >
            {t('settings.weaveInstall', 'Install')}
          </a>
        </div>
      </SettingRow>
    );
  }

  return (
    <SettingRow
      title={t('settings.weaveTitle', 'Semantic Merge (Weave)')}
      description={t('settings.weaveDesc', 'Reduces false merge conflicts using semantic analysis')}
    >
      <div className="flex items-center gap-3">
        <span
          data-testid="settings-weave-status"
          className={cn(
            'text-xs',
            status.status === 'active' ? 'text-green-500' : 'text-muted-foreground',
          )}
        >
          {status.status === 'active'
            ? t('settings.weaveActive', 'Active')
            : t('settings.weaveUnconfigured', 'Not configured')}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={handleConfigure}
          disabled={configuring}
          data-testid="settings-weave-configure"
        >
          {configuring
            ? t('settings.weaveConfiguring', 'Configuring...')
            : status.status === 'active'
              ? t('settings.weaveReconfigure', 'Reconfigure')
              : t('settings.weaveConfigure', 'Configure')}
        </Button>
      </div>
    </SettingRow>
  );
}
