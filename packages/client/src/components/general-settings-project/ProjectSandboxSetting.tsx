/**
 * The project's sandbox for the current user (change project-sandboxes): which
 * of their provider connections new threads use, at what size, and whether the
 * composer starts with the sandbox on. Only the project owner can run sandbox
 * threads, so other users see nothing.
 */
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { clearProjectSandbox, saveProjectSandbox } from '@/data/runner/actions';
import { useProjectSandbox, useSandboxConnections, useSandboxProviders } from '@/data/runner/hooks';
import { buildPath } from '@/lib/url';
import { useAuthStore } from '@/stores/auth-store';

import { SettingRow } from './setting-primitives';

const NO_SANDBOX = '__none__';

/** Rendered for the project owner only; nothing is fetched for anyone else. */
export function ProjectSandboxSetting({
  projectId,
  ownerId,
}: {
  projectId: string;
  ownerId: string;
}) {
  const isOwner = useAuthStore((s) => s.user?.id === ownerId);
  return isOwner ? <ProjectSandboxRows projectId={projectId} /> : null;
}

function ProjectSandboxRows({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { connections, loading } = useSandboxConnections();
  const providers = useSandboxProviders();
  const { sandbox } = useProjectSandbox(projectId);
  const settings = sandbox?.settings ?? null;

  if (!loading && connections.length === 0) {
    return (
      <SettingRow
        title={t('settings.projectSandbox', 'Sandbox')}
        description={t(
          'settings.projectSandboxNoConnections',
          'Add a sandbox provider connection to run this project’s threads in a sandbox.',
        )}
      >
        <Button
          variant="outline"
          size="sm"
          data-testid="settings-project-sandbox-add-connection"
          onClick={() => navigate(buildPath('/preferences/sandboxes'))}
        >
          {t('settings.projectSandboxAddConnection', 'Add a connection')}
        </Button>
      </SettingRow>
    );
  }

  const connection = connections.find((c) => c.id === settings?.connectionId);
  const sizes = providers.find((p) => p.id === connection?.provider)?.capabilities.sizes ?? [];
  // Two connections can share a name: the provider tells them apart.
  const providerName = (id: string) => providers.find((p) => p.id === id)?.displayName ?? id;

  const onConnectionChange = (value: string) => {
    if (value === NO_SANDBOX) {
      void clearProjectSandbox(projectId);
      return;
    }
    // A new connection may be another provider: start from its default size.
    void saveProjectSandbox(projectId, {
      connectionId: value,
      enabledByDefault: settings?.enabledByDefault ?? true,
    });
  };

  return (
    <>
      <SettingRow
        title={t('settings.projectSandbox', 'Sandbox')}
        description={t(
          'settings.projectSandboxDesc',
          'Provider connection your new threads in this project can run in',
        )}
      >
        <Select value={settings?.connectionId ?? NO_SANDBOX} onValueChange={onConnectionChange}>
          <SelectTrigger className="w-[220px]" data-testid="settings-project-sandbox-connection">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_SANDBOX} data-testid="settings-project-sandbox-connection-none">
              {t('settings.projectSandboxNone', 'None')}
            </SelectItem>
            {connections.map((c) => (
              <SelectItem
                key={c.id}
                value={c.id}
                data-testid={`settings-project-sandbox-connection-${c.id}`}
              >
                <span>{c.label}</span>
                <span className="text-muted-foreground">{` · ${providerName(c.provider)}`}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      {settings && (
        <>
          <SettingRow
            title={t('settings.projectSandboxSize', 'Sandbox size')}
            description={t('settings.projectSandboxSizeDesc', 'Machine size for new sandboxes')}
          >
            <Select
              value={settings.sizeId}
              onValueChange={(sizeId) =>
                void saveProjectSandbox(projectId, {
                  connectionId: settings.connectionId,
                  sizeId,
                  enabledByDefault: settings.enabledByDefault,
                })
              }
            >
              <SelectTrigger className="w-[220px]" data-testid="settings-project-sandbox-size">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sizes.map((s) => (
                  <SelectItem
                    key={s.id}
                    value={s.id}
                    data-testid={`settings-project-sandbox-size-${s.id}`}
                  >
                    {`${s.id} · ${s.vcpu} vCPU · ${s.memoryGb} GB`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow
            title={t('settings.projectSandboxDefault', 'On by default')}
            description={t(
              'settings.projectSandboxDefaultDesc',
              'New threads start with the sandbox turned on',
            )}
          >
            <Switch
              checked={settings.enabledByDefault}
              data-testid="settings-project-sandbox-default"
              onCheckedChange={(enabledByDefault) =>
                void saveProjectSandbox(projectId, {
                  connectionId: settings.connectionId,
                  sizeId: settings.sizeId,
                  enabledByDefault,
                })
              }
            />
          </SettingRow>
        </>
      )}
    </>
  );
}
