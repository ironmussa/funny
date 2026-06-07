/**
 * ProvidersSettings — manage runner-installed (external) ACP providers
 * (provider-install-ui). Providers are runner-owned: install copies a manifest
 * into the user's runner `<DATA_DIR>/extensions` and registers it live; remove
 * de-registers it. The spawn command is disclosed on install. Per-user-runner —
 * each user manages their own runner's providers.
 */
import { ACP_MANIFESTS, KNOWN_ACP_PROVIDER_IDS } from '@funny/shared/provider-manifests';
import { AlertTriangle, Cpu, Package, Power, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { systemApi, type AdvertisedProvider } from '@/lib/api/system';
import { createClientLogger } from '@/lib/client-logger';
import { useRunnerProvidersStore } from '@/stores/runner-providers-store';

const log = createClientLogger('providers-settings');

/** The gateable built-in ACP providers, with their display labels. */
const BUILTIN_ACP = KNOWN_ACP_PROVIDER_IDS.map((id) => ({ id, label: ACP_MANIFESTS[id].label }));

/** Heuristic: a git URL vs a local path on the runner. */
function isGitSource(s: string): boolean {
  return /:\/\//.test(s) || /^git@/.test(s) || /^(github|gh):/i.test(s);
}

export function ProvidersSettings() {
  const [providers, setProviders] = useState<AdvertisedProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState('');
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [togglingBuiltin, setTogglingBuiltin] = useState<string | null>(null);
  const refetchPicker = useRunnerProvidersStore((s) => s.fetch);
  const activeBuiltins = useRunnerProvidersStore((s) => s.activeBuiltins);
  const setActiveBuiltins = useRunnerProvidersStore((s) => s.setActiveBuiltins);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await systemApi.getProviders();
    if (result.isOk()) {
      setProviders(result.value.providers);
    } else {
      log.error('failed to list providers', { error: result.error.message });
      toast.error('Failed to load providers', { description: result.error.message });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    void refetchPicker(); // populate the store's activeBuiltins for the toggles
  }, [refresh, refetchPicker]);

  const handleInstall = useCallback(async () => {
    const src = source.trim();
    if (!src) return;
    setInstalling(true);
    const body = isGitSource(src) ? { git: src } : { path: src };
    const result = await systemApi.installProvider(body);
    if (result.isOk()) {
      const p = result.value.provider;
      toast.success(`Installed ${p.id}`, {
        description: `Launches "${[p.spawn.command, ...p.spawn.args].join(' ')}" on your runner.`,
      });
      setSource('');
      await refresh();
      await refetchPicker(true); // so the new provider shows in the model picker
    } else {
      toast.error('Install failed', { description: result.error.message });
    }
    setInstalling(false);
  }, [source, refresh, refetchPicker]);

  // A built-in is active when the runner advertises no set (null = unknown, all
  // active — no regression) or when it's in the advertised active set.
  const isBuiltinActive = useCallback(
    (id: string) => activeBuiltins === null || activeBuiltins.includes(id),
    [activeBuiltins],
  );

  const handleToggleBuiltin = useCallback(
    async (id: string, enable: boolean) => {
      setTogglingBuiltin(id);
      const result = await systemApi.setBuiltinEnabled(id, enable);
      if (result.isOk()) {
        // Optimistic: reflect in the picker now; the server cache catches up on
        // the next runner heartbeat.
        setActiveBuiltins(result.value.active);
        toast.success(`${enable ? 'Enabled' : 'Disabled'} ${id}`, {
          description: 'Session only — set FUNNY_PROVIDERS on the runner to persist.',
        });
      } else {
        toast.error(`${enable ? 'Enable' : 'Disable'} failed`, {
          description: result.error.message,
        });
      }
      setTogglingBuiltin(null);
    },
    [setActiveBuiltins],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      setRemoving(id);
      const result = await systemApi.removeProvider(id);
      if (result.isOk()) {
        toast.success(`Removed ${id}`);
        await refresh();
        await refetchPicker(true);
      } else {
        toast.error('Remove failed', { description: result.error.message });
      }
      setRemoving(null);
    },
    [refresh, refetchPicker],
  );

  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="settings-section-header mb-0">Providers</h3>
        <TooltipIconButton
          tooltip="Refresh"
          onClick={() => void refresh()}
          data-testid="providers-refresh"
        >
          <RefreshCw className={loading ? 'icon-base animate-spin' : 'icon-base'} />
        </TooltipIconButton>
      </div>

      <p className="text-muted-foreground px-1 pb-3 text-xs">
        Install ACP agent providers onto your runner. A provider is a declarative manifest pointing
        at an agent CLI already installed on the runner — installing one lets funny launch that
        binary.
      </p>

      <div className="settings-card mb-4 flex items-start gap-2 border-amber-500/30 bg-amber-500/5 p-3">
        <AlertTriangle className="icon-base mt-0.5 shrink-0 text-amber-500" />
        <span className="text-muted-foreground text-xs">
          Installing a provider lets funny spawn the binary it declares on your runner. Install only
          providers you trust.
        </span>
      </div>

      <div className="settings-card mb-4 p-4">
        <label className="text-muted-foreground mb-1 block text-xs font-medium">
          Install from a git repo or a local path on the runner
        </label>
        <div className="flex gap-2">
          <Input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="github:user/funny-myagent  ·  or  /path/to/funny-myagent"
            spellCheck={false}
            data-testid="providers-install-source"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !installing) void handleInstall();
            }}
          />
          <Button
            onClick={() => void handleInstall()}
            disabled={installing || !source.trim()}
            data-testid="providers-install-submit"
          >
            <Package className="icon-base mr-1" />
            {installing ? 'Installing…' : 'Install'}
          </Button>
        </div>
        <p className="text-muted-foreground mt-1 text-[11px]">
          The package must contain a <code>package.json</code> with a <code>funny.provider</code>{' '}
          entry pointing at a <code>funny.provider.json</code> manifest.
        </p>
      </div>

      <div className="mb-1 mt-2 flex items-baseline justify-between px-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Built-in providers
        </h4>
        <span className="text-muted-foreground text-[11px]">session toggle</span>
      </div>
      <p className="text-muted-foreground px-1 pb-2 text-[11px]">
        Enable or disable bundled ACP providers in the model picker. Resets on runner restart — set{' '}
        <code>FUNNY_PROVIDERS</code> on the runner to make a lean set the default.
      </p>
      <div className="mb-4 flex flex-col gap-2">
        {BUILTIN_ACP.map(({ id, label }) => {
          const active = isBuiltinActive(id);
          return (
            <div
              key={id}
              className="settings-card flex items-center gap-3 px-3 py-2.5"
              data-testid={`builtin-provider-${id}`}
            >
              <Power
                className={`icon-base shrink-0 ${active ? 'text-emerald-500' : 'text-muted-foreground/40'}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{label}</span>
                  <span className="text-muted-foreground text-xs">{id}</span>
                </div>
                <p className="text-muted-foreground truncate text-xs">
                  {active ? 'Active in the model picker' : 'Hidden from the model picker'}
                </p>
              </div>
              <Button
                variant={active ? 'ghost' : 'default'}
                size="sm"
                onClick={() => void handleToggleBuiltin(id, !active)}
                disabled={togglingBuiltin === id}
                data-testid={`builtin-toggle-${id}`}
              >
                {togglingBuiltin === id ? '…' : active ? 'Disable' : 'Enable'}
              </Button>
            </div>
          );
        })}
      </div>

      <div className="mb-1 mt-2 px-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Installed providers
        </h4>
      </div>
      {providers.length === 0 ? (
        <div className="settings-card flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Cpu className="text-muted-foreground/50 size-6" />
          <p className="text-muted-foreground text-sm">
            {loading ? 'Loading…' : 'No external providers installed.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {providers.map((p) => (
            <div
              key={p.id}
              className="settings-card flex items-center gap-3 px-3 py-2.5"
              data-testid={`provider-item-${p.id}`}
            >
              <Cpu className="icon-base text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{p.label}</span>
                  <span className="text-muted-foreground text-xs">{p.id}</span>
                </div>
                <p className="text-muted-foreground truncate text-xs">
                  {p.models.kind} catalog · default {p.models.defaultModel} · auth {p.auth.mode}
                </p>
              </div>
              <TooltipIconButton
                tooltip="Remove"
                onClick={() => void handleRemove(p.id)}
                disabled={removing === p.id}
                data-testid={`provider-remove-${p.id}`}
              >
                <Trash2 className="icon-base text-destructive" />
              </TooltipIconButton>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
