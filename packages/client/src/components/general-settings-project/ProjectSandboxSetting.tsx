/**
 * The project's sandbox for the current user (change project-runtime-settings):
 * which of their provider connections new threads use and at what size. Whether
 * new threads start in it is the Sandbox option of the default thread mode
 * (`ProjectThreadModeSetting`). Every member configures their own connection.
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
import { useCanSteerProject } from '@/data/projects/hooks';
import { clearProjectSandbox, saveProjectSandbox } from '@/data/runner/actions';
import { useProjectSandbox, useSandboxConnections, useSandboxProviders } from '@/data/runner/hooks';
import { buildPath } from '@/lib/url';

import { SettingRow } from './setting-primitives';

const NO_SANDBOX = '__none__';

/** The select value: the attached connection, or "none" (also for a row that kept only its runtime). */
function connectionValue(settings: { connectionId: string } | null): string {
  return settings?.connectionId || NO_SANDBOX;
}

/** The sizes the attached connection's provider offers. */
function sizesFor(
  connectionId: string | undefined,
  connections: ReturnType<typeof useSandboxConnections>['connections'],
  providers: ReturnType<typeof useSandboxProviders>,
) {
  const connection = connections.find((c) => c.id === connectionId);
  return providers.find((p) => p.id === connection?.provider)?.capabilities.sizes ?? [];
}

function ProjectSandboxSettingRows({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { connections, loading } = useSandboxConnections();
  const providers = useSandboxProviders();
  const { sandbox } = useProjectSandbox(projectId);
  const settings = sandbox?.settings ?? null;

  if (!loading && connections.length === 0) {
    return (
      <SettingRow
        settingId="project-general.sandbox"
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

  const sizes = sizesFor(settings?.connectionId, connections, providers);
  // Two connections can share a name: the provider tells them apart.
  const providerName = (id: string) => providers.find((p) => p.id === id)?.displayName ?? id;

  const onConnectionChange = (value: string) => {
    if (value === NO_SANDBOX) {
      void clearProjectSandbox(projectId);
      return;
    }
    // A new connection may be another provider: start from its default size.
    // Picking a connection does not change the runtime mode on its own.
    void saveProjectSandbox(projectId, {
      mode: settings?.mode ?? 'local',
      connectionId: value,
    });
  };

  return (
    <>
      <SettingRow
        settingId="project-general.sandbox"
        title={t('settings.projectSandbox', 'Sandbox')}
        description={t(
          'settings.projectSandboxDesc',
          'Provider connection your new threads in this project can run in',
        )}
      >
        <Select value={connectionValue(settings)} onValueChange={onConnectionChange}>
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
      {settings?.connectionId && (
        <SettingRow
          settingId="project-general.sandbox-size"
          title={t('settings.projectSandboxSize', 'Sandbox size')}
          description={t('settings.projectSandboxSizeDesc', 'Machine size for new sandboxes')}
        >
          <Select
            value={settings.sizeId}
            onValueChange={(sizeId) =>
              void saveProjectSandbox(projectId, {
                mode: settings.mode,
                connectionId: settings.connectionId,
                sizeId,
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
      )}
    </>
  );
}

/** Hidden from a viewer: the setting is per-user and only matters to whoever may start threads. */
export function ProjectSandboxSetting({ projectId }: { projectId: string }) {
  const canSteer = useCanSteerProject(projectId);
  return canSteer ? <ProjectSandboxSettingRows projectId={projectId} /> : null;
}
