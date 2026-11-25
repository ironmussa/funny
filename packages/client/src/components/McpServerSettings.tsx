import type { AgentProvider } from '@funny/shared';
import { Plus, AlertCircle, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AddMcpServerForm } from '@/components/mcp-server-settings/AddMcpServerForm';
import {
  InstalledServerCard,
  RecommendedServerCard,
} from '@/components/mcp-server-settings/McpServerCards';
import { useMcpServerSettings } from '@/components/mcp-server-settings/use-mcp-servers';
import { SettingsSection } from '@/components/settings/SettingRow';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const MCP_PROVIDER_OPTIONS: Array<{ value: AgentProvider; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
];

function McpRemoveDialog({
  name,
  onCancel,
  onConfirm,
}: {
  name: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={!!name} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('mcp.confirmRemoveTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('mcp.confirmRemoveDescription', { name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="mcp-remove-cancel">{t('mcp.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            data-testid="mcp-remove-confirm"
            onClick={onConfirm}
            variant="destructive"
          >
            {t('common.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function McpServerSettings() {
  const { t } = useTranslation();
  const {
    projectPath,
    servers,
    recommended,
    loading,
    error,
    setError,
    removingName,
    installingName,
    authenticatingName,
    settingTokenName,
    togglingName,
    showAddForm,
    setShowAddForm,
    confirmRemoveName,
    setConfirmRemoveName,
    selectedProvider,
    setSelectedProvider,
    addForm,
    handleRemove,
    confirmRemove,
    handleToggle,
    handleInstallRecommended,
    handleAddCustom,
    handleAuthenticate,
    handleSetToken,
  } = useMcpServerSettings();

  const installedNames = new Set(servers.map((s) => s.name));

  if (!projectPath) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <AlertCircle className="icon-base" />
        {t('mcp.selectProject')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Error banner */}
      {error && (
        <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-md px-3 py-2 text-xs">
          <AlertCircle className="icon-sm shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-xs underline">
            {t('mcp.dismiss')}
          </button>
        </div>
      )}

      {/* Installed servers */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <SettingsSection settingId="mcp-server.installed" className="px-0 pb-0">
            {t('mcp.installedServers')}
          </SettingsSection>
          <div className="flex items-center gap-2">
            <Select
              value={selectedProvider}
              onValueChange={(v) => {
                // SAFETY: the select's items are MCP_PROVIDER_OPTIONS, whose values are AgentProviders.
                setSelectedProvider(v as AgentProvider);
                setShowAddForm(false);
              }}
            >
              <SelectTrigger
                className="h-8 w-[150px]"
                aria-label={t('mcp.agentProvider')}
                data-testid="mcp-provider-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MCP_PROVIDER_OPTIONS.map((provider) => (
                  <SelectItem key={provider.value} value={provider.value}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm-tight" onClick={() => setShowAddForm(!showAddForm)}>
              {showAddForm ? (
                <ChevronUp className="icon-xs mr-1" />
              ) : (
                <Plus className="icon-xs mr-1" />
              )}
              {showAddForm ? t('mcp.cancel') : t('mcp.addCustom')}
            </Button>
          </div>
        </div>

        {/* Add custom server form */}
        {showAddForm && <AddMcpServerForm form={addForm} onAdd={handleAddCustom} />}

        {loading ? (
          <LoadingState
            padding="md"
            fill={false}
            layout="inline"
            testId="mcp-settings-loading"
            label={t('mcp.loadingServers')}
          />
        ) : servers.length === 0 ? (
          <EmptyState padding="md" fill={false} title={t('mcp.noServers')} />
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {servers.map((server) => (
              <InstalledServerCard
                key={server.name}
                server={server}
                onRemove={() => handleRemove(server.name)}
                removing={removingName === server.name}
                onToggle={(disabled) => handleToggle(server.name, disabled)}
                toggling={togglingName === server.name}
                onAuthenticate={() => handleAuthenticate(server)}
                authenticating={authenticatingName === server.name}
                onSetToken={(token) => handleSetToken(server, token)}
                settingToken={settingTokenName === server.name}
              />
            ))}
          </div>
        )}
      </div>

      {/* Recommended servers */}
      {recommended.length > 0 && (
        <div>
          <SettingsSection settingId="mcp-server.recommended" className="mb-2 px-0 pb-0">
            {t('mcp.recommendedServers')}
          </SettingsSection>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recommended.map((server) => (
              <RecommendedServerCard
                key={server.name}
                server={server}
                installed={installedNames.has(server.name)}
                onInstall={() => handleInstallRecommended(server)}
                installing={installingName === server.name}
              />
            ))}
          </div>
        </div>
      )}

      <McpRemoveDialog
        name={confirmRemoveName}
        onCancel={() => setConfirmRemoveName(null)}
        onConfirm={confirmRemove}
      />
    </div>
  );
}
