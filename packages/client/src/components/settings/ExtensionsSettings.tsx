/**
 * ExtensionsSettings — manage installed client extensions (visualizer plugins).
 *
 * Extensions are global to the server and live at `~/.funny/extensions`. v1
 * install copies a local pre-built package directory on the server host; remove
 * deletes it. Newly installed visualizers register live; removed ones fully
 * unload on the next page reload. Install/remove are admin-only (they mutate
 * server-global, every-user state) — non-admins see a read-only list.
 */
import { AlertTriangle, Package, Puzzle, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { api } from '@/lib/api';
import type { InstalledExtension } from '@/lib/api/extensions';
import { createClientLogger } from '@/lib/client-logger';
import { loadInstalledVisualizers } from '@/lib/visualizer-loader';
import { useAuthStore } from '@/stores/auth-store';

const log = createClientLogger('extensions-settings');

export function ExtensionsSettings() {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [loading, setLoading] = useState(true);
  const [installPath, setInstallPath] = useState('');
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await api.listInstalledExtensions();
    if (result.isOk()) {
      setExtensions(result.value);
    } else {
      log.error('failed to list extensions', { error: result.error.message });
      toast.error('Failed to load extensions', { description: result.error.message });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInstall = useCallback(async () => {
    const path = installPath.trim();
    if (!path) return;
    setInstalling(true);
    const result = await api.installExtension(path);
    if (result.isOk()) {
      toast.success(`Installed ${result.value.extension.id}`);
      setInstallPath('');
      await refresh();
      await loadInstalledVisualizers(); // register the new visualizer live (idempotent)
    } else {
      toast.error('Install failed', { description: result.error.message });
    }
    setInstalling(false);
  }, [installPath, refresh]);

  const handleRemove = useCallback(
    async (ext: InstalledExtension) => {
      setRemoving(ext.name);
      const result = await api.removeExtension(ext.name);
      if (result.isOk()) {
        toast.success(`Removed ${ext.id}`, { description: 'Reload the page to fully unload it.' });
        await refresh();
      } else {
        toast.error('Remove failed', { description: result.error.message });
      }
      setRemoving(null);
    },
    [refresh],
  );

  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="settings-section-header mb-0">Extensions</h3>
        <TooltipIconButton
          tooltip="Refresh"
          onClick={() => void refresh()}
          data-testid="extensions-refresh"
        >
          <RefreshCw className={loading ? 'icon-base animate-spin' : 'icon-base'} />
        </TooltipIconButton>
      </div>

      <p className="px-1 pb-3 text-xs text-muted-foreground">
        Visualizer plugins extend how funny renders fenced code blocks and file previews. They run
        with full access to your session — install only extensions you trust.
      </p>

      <div className="settings-card mb-4 flex items-start gap-2 border-amber-500/30 bg-amber-500/5 p-3">
        <AlertTriangle className="icon-base mt-0.5 flex-shrink-0 text-amber-500" />
        <span className="text-xs text-muted-foreground">
          Installing an extension runs its code inside your authenticated session, like installing
          an npm package. There is no sandbox.
        </span>
      </div>

      {/* Install by local path (admin only) */}
      {isAdmin && (
        <div className="settings-card mb-4 p-4">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Install from a local package directory (on the server)
          </label>
          <div className="flex gap-2">
            <Input
              value={installPath}
              onChange={(e) => setInstallPath(e.target.value)}
              placeholder="/path/to/funny-visualizer-xyz"
              spellCheck={false}
              data-testid="extensions-install-path"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !installing) void handleInstall();
              }}
            />
            <Button
              onClick={() => void handleInstall()}
              disabled={installing || !installPath.trim()}
              data-testid="extensions-install-submit"
            >
              <Package className="icon-base mr-1" />
              {installing ? 'Installing…' : 'Install'}
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            The directory must contain a <code>package.json</code> with a <code>funny.client</code>{' '}
            entry pointing at the built ESM bundle.
          </p>
        </div>
      )}

      {/* Installed list */}
      {extensions.length === 0 ? (
        <div className="settings-card flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Puzzle className="size-6 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {loading ? 'Loading…' : 'No extensions installed.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {extensions.map((ext) => (
            <div
              key={ext.name}
              className="settings-card flex items-center gap-3 px-3 py-2.5"
              data-testid={`extension-item-${ext.name}`}
            >
              <Puzzle className="icon-base flex-shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{ext.id}</span>
                  <span className="text-xs text-muted-foreground">v{ext.version}</span>
                </div>
                {ext.description && (
                  <p className="truncate text-xs text-muted-foreground">{ext.description}</p>
                )}
              </div>
              {isAdmin && (
                <TooltipIconButton
                  tooltip="Remove"
                  onClick={() => void handleRemove(ext)}
                  disabled={removing === ext.name}
                  data-testid={`extension-remove-${ext.name}`}
                >
                  <Trash2 className="icon-base text-destructive" />
                </TooltipIconButton>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
