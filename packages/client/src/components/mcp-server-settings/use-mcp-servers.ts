import type { AgentProvider, McpServer, McpServerType } from '@funny/shared';
import type { TFunction } from 'i18next';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useProjects } from '@/data/projects/hooks';
import { api } from '@/lib/api';
import { whilePending } from '@/lib/while-pending';
import { useProjectStore } from '@/stores/project-store';

import type { RecommendedServer } from './McpServerCards';

type Setter<T> = (value: T) => void;

function useMcpAddFormState() {
  const [addName, setAddName] = useState('');
  const [addType, setAddType] = useState<McpServerType>('stdio');
  const [addUrl, setAddUrl] = useState('');
  const [addCommand, setAddCommand] = useState('');
  const [addArgs, setAddArgs] = useState('');
  const [adding, setAdding] = useState(false);
  return {
    addName,
    setAddName,
    addType,
    setAddType,
    addUrl,
    setAddUrl,
    addCommand,
    setAddCommand,
    addArgs,
    setAddArgs,
    adding,
    setAdding,
  };
}

export type McpAddForm = ReturnType<typeof useMcpAddFormState>;

interface McpActionContext {
  projectPath: string | null;
  projectId: string | undefined;
  selectedProvider: AgentProvider;
  loadServers: () => Promise<void> | undefined;
  setError: Setter<string | null>;
  confirmRemoveName: string | null;
  setConfirmRemoveName: Setter<string | null>;
  setRemovingName: Setter<string | null>;
  setTogglingName: Setter<string | null>;
  setInstallingName: Setter<string | null>;
  setAuthenticatingName: Setter<string | null>;
  setSettingTokenName: Setter<string | null>;
  setShowAddForm: Setter<boolean>;
  addForm: McpAddForm;
}

interface McpOAuthContext {
  t: TFunction;
  projectPath: string | null;
  projectId: string | undefined;
  selectedProvider: AgentProvider;
  loadServers: () => Promise<void> | undefined;
  setError: Setter<string | null>;
  setAuthenticatingName: Setter<string | null>;
}

function useMcpOAuth(ctx: McpOAuthContext) {
  const { t, projectPath, projectId, selectedProvider, loadServers, setError } = ctx;
  const { setAuthenticatingName } = ctx;
  const oauthCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => oauthCleanupRef.current?.(), []);
  return async (server: McpServer) => {
    if (!projectPath) return;
    setAuthenticatingName(server.name);
    setError(null);
    const result = await api.startMcpOAuth(server.name, projectPath, selectedProvider, projectId);
    if (result.isErr()) {
      setError(result.error.message);
      setAuthenticatingName(null);
      return;
    }

    const { authUrl } = result.value;

    oauthCleanupRef.current?.();

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.innerWidth - width) / 2;
    const top = window.screenY + (window.innerHeight - height) / 2;
    const popup = window.open(
      authUrl,
      'mcp-oauth',
      `width=${width},height=${height},left=${left},top=${top},popup=yes`,
    );

    const cleanupOAuth = () => {
      clearInterval(checkClosed);
      window.removeEventListener('message', handleMessage);
    };
    const handleMessage = (event: MessageEvent) => {
      // Validate origin to prevent cross-origin message injection
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'mcp-oauth-callback') {
        cleanupOAuth();
        setAuthenticatingName(null);
        // Closing from the parent is more reliable after cross-origin OAuth navigation.
        if (popup && !popup.closed) popup.close();
        if (event.data.success) loadServers();
        else setError(event.data.error || t('mcp.authFailed'));
      }
    };
    window.addEventListener('message', handleMessage);

    // cleanupOAuth clears this interval on completion, replacement, and component unmount.
    // react-doctor-disable-next-line effect-needs-cleanup
    const checkClosed = setInterval(() => {
      if (popup && popup.closed) {
        cleanupOAuth();
        setAuthenticatingName(null);
        loadServers();
      }
    }, 500);
    oauthCleanupRef.current = cleanupOAuth;
  };
}

function createAddCustomHandler(ctx: McpActionContext) {
  const { projectPath, projectId, selectedProvider, loadServers, setError, setShowAddForm } = ctx;
  const { addName, addType, addUrl, addCommand, addArgs, setAdding } = ctx.addForm;
  const { setAddName, setAddUrl, setAddCommand, setAddArgs } = ctx.addForm;
  return async () => {
    if (!projectPath || !addName) return;
    setAdding(true);
    setError(null);
    const data: any = {
      name: addName,
      provider: selectedProvider,
      type: addType,
      projectPath,
      projectId,
    };
    if (addType === 'http' || addType === 'sse') {
      data.url = addUrl;
    } else {
      data.command = addCommand;
      data.args = addArgs.split(/\s+/).filter(Boolean);
    }
    const result = await api.addMcpServer(data);
    if (result.isErr()) {
      setError(result.error.message);
    } else {
      await loadServers();
      // Reset form
      setAddName('');
      setAddUrl('');
      setAddCommand('');
      setAddArgs('');
      setShowAddForm(false);
    }
    setAdding(false);
  };
}

function createMcpServerActions(ctx: McpActionContext) {
  const { projectPath, projectId, selectedProvider, loadServers, setError } = ctx;

  const handleRemove = (name: string) => {
    ctx.setConfirmRemoveName(name);
  };

  const confirmRemove = async () => {
    if (!projectPath || !ctx.confirmRemoveName) return;
    const name = ctx.confirmRemoveName;
    ctx.setConfirmRemoveName(null);
    ctx.setRemovingName(name);
    const result = await api.removeMcpServer(name, projectPath, selectedProvider, projectId);
    if (result.isErr()) {
      setError(result.error.message);
    } else {
      await loadServers();
    }
    ctx.setRemovingName(null);
  };

  const handleToggle = async (name: string, disabled: boolean) => {
    if (!projectPath) return;
    ctx.setTogglingName(name);
    const result = await api.toggleMcpServer(
      name,
      projectPath,
      disabled,
      selectedProvider,
      projectId,
    );
    if (result.isErr()) {
      setError(result.error.message);
    } else {
      await loadServers();
    }
    ctx.setTogglingName(null);
  };

  const handleInstallRecommended = async (server: RecommendedServer) => {
    if (!projectPath) return;
    ctx.setInstallingName(server.name);
    const result = await api.addMcpServer({
      name: server.name,
      provider: selectedProvider,
      type: server.type,
      url: server.url,
      command: server.command,
      args: server.args,
      projectPath,
      projectId,
    });
    if (result.isErr()) {
      setError(result.error.message);
    } else {
      await loadServers();
    }
    ctx.setInstallingName(null);
  };

  const handleSetToken = async (server: McpServer, token: string) => {
    if (!projectPath) return;
    ctx.setSettingTokenName(server.name);
    setError(null);
    const result = await api.setMcpToken(
      server.name,
      projectPath,
      token,
      selectedProvider,
      projectId,
    );
    if (result.isErr()) {
      setError(result.error.message);
    } else {
      await loadServers();
    }
    ctx.setSettingTokenName(null);
  };

  return {
    handleRemove,
    confirmRemove,
    handleToggle,
    handleInstallRecommended,
    handleAddCustom: createAddCustomHandler(ctx),
    handleSetToken,
  };
}

function useMcpListState() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [recommended, setRecommended] = useState<RecommendedServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return { servers, setServers, recommended, setRecommended, loading, setLoading, error, setError };
}

/** The name of the server each per-server action is busy with, if any. */
function useMcpBusyNames() {
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [installingName, setInstallingName] = useState<string | null>(null);
  const [authenticatingName, setAuthenticatingName] = useState<string | null>(null);
  const [settingTokenName, setSettingTokenName] = useState<string | null>(null);
  const [togglingName, setTogglingName] = useState<string | null>(null);
  return {
    removingName,
    setRemovingName,
    installingName,
    setInstallingName,
    authenticatingName,
    setAuthenticatingName,
    settingTokenName,
    setSettingTokenName,
    togglingName,
    setTogglingName,
  };
}

function useMcpPanelState() {
  const [showAddForm, setShowAddForm] = useState(false);
  const [confirmRemoveName, setConfirmRemoveName] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>('claude');
  return {
    showAddForm,
    setShowAddForm,
    confirmRemoveName,
    setConfirmRemoveName,
    selectedProvider,
    setSelectedProvider,
  };
}

function pickSelectedProject<P extends { id: string }>(
  projects: P[],
  selectedProjectId: string | null,
): P | null {
  if (selectedProjectId) {
    return projects.find((p) => p.id === selectedProjectId) ?? null;
  }
  return projects[0] ?? null;
}

/** Fetches the recommended servers the first time it runs for a mounted component. */
function loadRecommendedOnce(
  loadedRef: { current: boolean },
  setRecommended: Setter<RecommendedServer[]>,
): void {
  if (loadedRef.current) return;
  loadedRef.current = true;
  (async () => {
    const result = await api.getRecommendedMcpServers();
    if (result.isOk()) {
      // SAFETY: /mcp/recommended answers the runtime's RECOMMENDED_SERVERS, whose
      // entries all have a name, description and type; the API typing as McpServer
      // just omits `description`.
      setRecommended(result.value.servers as RecommendedServer[]);
    }
  })();
}

/** Loads the installed servers, and reloads them when the project or provider changes. */
function useMcpServerLoader({
  projectPath,
  projectId,
  selectedProvider,
  setLoading,
  setError,
  setServers,
}: {
  projectPath: string | null;
  projectId: string | undefined;
  selectedProvider: AgentProvider;
  setLoading: Setter<boolean>;
  setError: Setter<string | null>;
  setServers: Setter<McpServer[]>;
}) {
  const loadServers = useCallback(async () => {
    if (!projectPath) return;
    return whilePending(setLoading, async () => {
      setError(null);
      const result = await api.listMcpServers(projectPath, selectedProvider, projectId);
      if (result.isOk()) {
        setServers(result.value.servers);
      } else {
        setError(result.error.message);
      }
    });
  }, [projectPath, projectId, selectedProvider, setLoading, setError, setServers]);

  // Load servers when projectPath changes (track previous to avoid duplicate calls)
  const prevProjectPathRef = useRef<string | null>(null);
  useEffect(() => {
    const loadKey = projectPath ? `${projectPath}:${selectedProvider}:${projectId ?? ''}` : null;
    if (!projectPath || loadKey === prevProjectPathRef.current) return;
    prevProjectPathRef.current = loadKey;
    loadServers();
  }, [projectPath, selectedProvider, projectId, loadServers]);

  return loadServers;
}

export function useMcpServerSettings() {
  const { t } = useTranslation();
  const projects = useProjects();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const { servers, setServers, recommended, setRecommended, loading, setLoading, error, setError } =
    useMcpListState();
  const busy = useMcpBusyNames();
  const { setRemovingName, setInstallingName, setAuthenticatingName } = busy;
  const { setSettingTokenName, setTogglingName } = busy;
  const panel = useMcpPanelState();
  const { showAddForm, setShowAddForm, confirmRemoveName, setConfirmRemoveName } = panel;
  const { selectedProvider, setSelectedProvider } = panel;

  // Add form state
  const addForm = useMcpAddFormState();

  // Derive project path directly (no useEffect + setState cascade)
  const selectedProject = pickSelectedProject(projects, selectedProjectId);
  const projectPath = selectedProject?.path ?? null;
  const projectId = selectedProject?.id;

  const loadServers = useMcpServerLoader({
    projectPath,
    projectId,
    selectedProvider,
    setLoading,
    setError,
    setServers,
  });

  const recommendedLoadedRef = useRef(false);
  const handleAuthenticate = useMcpOAuth({
    t,
    projectPath,
    projectId,
    selectedProvider,
    loadServers,
    setError,
    setAuthenticatingName,
  });
  useEffect(() => loadRecommendedOnce(recommendedLoadedRef, setRecommended), [setRecommended]);

  const actions = createMcpServerActions({
    projectPath,
    projectId,
    selectedProvider,
    loadServers,
    setError,
    confirmRemoveName,
    setConfirmRemoveName,
    setRemovingName,
    setTogglingName,
    setInstallingName,
    setAuthenticatingName,
    setSettingTokenName,
    setShowAddForm,
    addForm,
  });

  return {
    projectPath,
    servers,
    recommended,
    loading,
    error,
    setError,
    removingName: busy.removingName,
    installingName: busy.installingName,
    authenticatingName: busy.authenticatingName,
    settingTokenName: busy.settingTokenName,
    togglingName: busy.togglingName,
    showAddForm,
    setShowAddForm,
    confirmRemoveName,
    setConfirmRemoveName,
    selectedProvider,
    setSelectedProvider,
    addForm,
    handleAuthenticate,
    ...actions,
  };
}
