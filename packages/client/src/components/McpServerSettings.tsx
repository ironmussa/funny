import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  Trash2,
  Plus,
  Globe,
  Terminal,
  Loader2,
  AlertCircle,
  Download,
  Server,
  ChevronDown,
  ChevronUp,
  ShieldAlert,
} from 'lucide-react';
import type { McpServer, McpServerType } from '@a-parallel/shared';

interface RecommendedServer {
  name: string;
  description: string;
  type: McpServerType;
  url?: string;
  command?: string;
  args?: string[];
}

function TypeBadge({ type }: { type: McpServerType }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider',
        type === 'http'
          ? 'bg-blue-500/10 text-blue-500'
          : type === 'sse'
            ? 'bg-amber-500/10 text-amber-500'
            : 'bg-green-500/10 text-green-500'
      )}
    >
      {type === 'stdio' ? (
        <Terminal className="h-2.5 w-2.5" />
      ) : (
        <Globe className="h-2.5 w-2.5" />
      )}
      {type}
    </span>
  );
}

function InstalledServerCard({
  server,
  onRemove,
  removing,
  onAuthenticate,
  authenticating,
}: {
  server: McpServer;
  onRemove: () => void;
  removing: boolean;
  onAuthenticate?: () => void;
  authenticating?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className={cn(
      "flex flex-col gap-1.5 px-3 py-2.5 rounded-md border bg-card",
      server.status === 'needs_auth' ? 'border-amber-500/40' : 'border-border/50'
    )}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Server className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{server.name}</span>
              <TypeBadge type={server.type} />
              {server.status === 'needs_auth' && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-500">
                  <ShieldAlert className="h-2.5 w-2.5" />
                  {t('mcp.needsAuth')}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {server.url || [server.command, ...(server.args || [])].join(' ')}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onRemove}
          disabled={removing}
          className="text-muted-foreground hover:text-destructive flex-shrink-0"
        >
          {removing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      {server.status === 'needs_auth' && (
        <div className="flex items-center justify-between pl-7 gap-2">
          <p className="text-[11px] text-amber-500/80">
            {t('mcp.authHint')}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={onAuthenticate}
            disabled={authenticating}
            className="text-xs h-6 px-2 border-amber-500/40 text-amber-500 hover:bg-amber-500/10 flex-shrink-0"
          >
            {authenticating ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <ShieldAlert className="h-3 w-3 mr-1" />
            )}
            {authenticating ? t('mcp.authenticating') : t('mcp.authenticate')}
          </Button>
        </div>
      )}
    </div>
  );
}

function RecommendedServerCard({
  server,
  installed,
  onInstall,
  installing,
}: {
  server: RecommendedServer;
  installed: boolean;
  onInstall: () => void;
  installing: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border border-border/50 bg-card">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{server.name}</span>
          <TypeBadge type={server.type} />
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{server.description}</p>
      </div>
      <Button
        variant={installed ? 'ghost' : 'outline'}
        size="sm"
        onClick={onInstall}
        disabled={installed || installing}
        className="flex-shrink-0 text-xs h-7"
      >
        {installing ? (
          <Loader2 className="h-3 w-3 animate-spin mr-1" />
        ) : installed ? null : (
          <Download className="h-3 w-3 mr-1" />
        )}
        {installed ? t('mcp.installed') : installing ? t('mcp.installing') : t('mcp.install')}
      </Button>
    </div>
  );
}

export function McpServerSettings() {
  const { t } = useTranslation();
  const projects = useAppStore(s => s.projects);
  const selectedProjectId = useAppStore(s => s.selectedProjectId);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [recommended, setRecommended] = useState<RecommendedServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [installingName, setInstallingName] = useState<string | null>(null);
  const [authenticatingName, setAuthenticatingName] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Add form state
  const [addName, setAddName] = useState('');
  const [addType, setAddType] = useState<McpServerType>('stdio');
  const [addUrl, setAddUrl] = useState('');
  const [addCommand, setAddCommand] = useState('');
  const [addArgs, setAddArgs] = useState('');
  const [adding, setAdding] = useState(false);

  // Resolve project path from selected project
  useEffect(() => {
    if (selectedProjectId) {
      const project = projects.find((p) => p.id === selectedProjectId);
      if (project) {
        setProjectPath(project.path);
      }
    } else if (projects.length > 0) {
      setProjectPath(projects[0].path);
    }
  }, [selectedProjectId, projects]);

  const loadServers = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.listMcpServers(projectPath);
      setServers(res.servers);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  const loadRecommended = useCallback(async () => {
    try {
      const res = await api.getRecommendedMcpServers();
      setRecommended(res.servers as unknown as RecommendedServer[]);
    } catch {
      // Silently fail for recommended
    }
  }, []);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  useEffect(() => {
    loadRecommended();
  }, [loadRecommended]);

  const handleRemove = async (name: string) => {
    if (!projectPath) return;
    setRemovingName(name);
    try {
      await api.removeMcpServer(name, projectPath);
      await loadServers();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRemovingName(null);
    }
  };

  const handleInstallRecommended = async (server: RecommendedServer) => {
    if (!projectPath) return;
    setInstallingName(server.name);
    try {
      await api.addMcpServer({
        name: server.name,
        type: server.type,
        url: server.url,
        command: server.command,
        args: server.args,
        projectPath,
      });
      await loadServers();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setInstallingName(null);
    }
  };

  const handleAddCustom = async () => {
    if (!projectPath || !addName) return;
    setAdding(true);
    setError(null);
    try {
      const data: any = {
        name: addName,
        type: addType,
        projectPath,
      };
      if (addType === 'http' || addType === 'sse') {
        data.url = addUrl;
      } else {
        data.command = addCommand;
        data.args = addArgs.split(/\s+/).filter(Boolean);
      }
      await api.addMcpServer(data);
      await loadServers();
      // Reset form
      setAddName('');
      setAddUrl('');
      setAddCommand('');
      setAddArgs('');
      setShowAddForm(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleAuthenticate = async (server: McpServer) => {
    if (!projectPath) return;
    setAuthenticatingName(server.name);
    setError(null);
    try {
      const { authUrl } = await api.startMcpOAuth(server.name, projectPath);

      const width = 600;
      const height = 700;
      const left = window.screenX + (window.innerWidth - width) / 2;
      const top = window.screenY + (window.innerHeight - height) / 2;
      const popup = window.open(
        authUrl,
        'mcp-oauth',
        `width=${width},height=${height},left=${left},top=${top},popup=yes`,
      );

      const handleMessage = (event: MessageEvent) => {
        if (event.data?.type === 'mcp-oauth-callback') {
          window.removeEventListener('message', handleMessage);
          setAuthenticatingName(null);
          if (event.data.success) {
            loadServers();
          } else {
            setError(event.data.error || t('mcp.authFailed'));
          }
        }
      };
      window.addEventListener('message', handleMessage);

      // Fallback: detect popup closed manually
      const checkClosed = setInterval(() => {
        if (popup && popup.closed) {
          clearInterval(checkClosed);
          window.removeEventListener('message', handleMessage);
          setAuthenticatingName(null);
          loadServers();
        }
      }, 500);
    } catch (err: any) {
      setError(err.message);
      setAuthenticatingName(null);
    }
  };

  const installedNames = new Set(servers.map((s) => s.name));

  if (!projectPath) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        {t('mcp.selectProject')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Project indicator */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Server className="h-3.5 w-3.5" />
        <span>
          {t('mcp.showingFor')}{' '}
          <span className="font-medium text-foreground">
            {projects.find((p) => p.path === projectPath)?.name || projectPath}
          </span>
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-xs underline">
            {t('mcp.dismiss')}
          </button>
        </div>
      )}

      {/* Installed servers */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t('mcp.installedServers')}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAddForm(!showAddForm)}
            className="text-xs h-6 px-2"
          >
            {showAddForm ? (
              <ChevronUp className="h-3 w-3 mr-1" />
            ) : (
              <Plus className="h-3 w-3 mr-1" />
            )}
            {showAddForm ? t('mcp.cancel') : t('mcp.addCustom')}
          </Button>
        </div>

        {/* Add custom server form */}
        {showAddForm && (
          <div className="rounded-lg border border-border/50 p-3 mb-3 space-y-3 bg-muted/30">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t('mcp.name')}</label>
                <input
                  type="text"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder="my-server"
                  className="w-full h-8 px-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t('mcp.type')}</label>
                <Select value={addType} onValueChange={(v) => setAddType(v as McpServerType)}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">stdio</SelectItem>
                    <SelectItem value="http">http</SelectItem>
                    <SelectItem value="sse">sse</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {addType === 'http' || addType === 'sse' ? (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t('mcp.url')}</label>
                <input
                  type="text"
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                  placeholder="https://api.example.com/mcp"
                  className="w-full h-8 px-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">{t('mcp.command')}</label>
                  <input
                    type="text"
                    value={addCommand}
                    onChange={(e) => setAddCommand(e.target.value)}
                    placeholder="npx"
                    className="w-full h-8 px-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">{t('mcp.arguments')}</label>
                  <input
                    type="text"
                    value={addArgs}
                    onChange={(e) => setAddArgs(e.target.value)}
                    placeholder="-y @package/name"
                    className="w-full h-8 px-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={handleAddCustom}
                disabled={!addName || adding}
                className="text-xs h-7"
              >
                {adding ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Plus className="h-3 w-3 mr-1" />
                )}
                {t('mcp.addServer')}
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('mcp.loadingServers')}
          </div>
        ) : servers.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t('mcp.noServers')}
          </div>
        ) : (
          <div className="space-y-1.5">
            {servers.map((server) => (
              <InstalledServerCard
                key={server.name}
                server={server}
                onRemove={() => handleRemove(server.name)}
                removing={removingName === server.name}
                onAuthenticate={() => handleAuthenticate(server)}
                authenticating={authenticatingName === server.name}
              />
            ))}
          </div>
        )}
      </div>

      {/* Recommended servers */}
      {recommended.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            {t('mcp.recommendedServers')}
          </h3>
          <div className="space-y-1.5">
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
    </div>
  );
}
