import type { GitHubRepo } from '@funny/shared';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { LoadingState } from '@/components/ui/loading-state';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

import type { ViewState } from './clone-repo/clone-view-state';
import { CloneConfigForm } from './clone-repo/CloneConfigForm';
import { CloneProgressView } from './clone-repo/CloneProgressView';
import { ConnectGithubView } from './clone-repo/ConnectGithubView';
import { ConnectionErrorView } from './clone-repo/ConnectionErrorView';
import { DeviceFlowView } from './clone-repo/DeviceFlowView';
import { RepoBrowser } from './clone-repo/RepoBrowser';
import { useCloneProgress } from './clone-repo/use-clone-progress';
import { useRepoFeed, useRepoListState } from './clone-repo/use-repo-feed';

interface CloneRepoViewProps {
  onCloningChange?: (cloning: boolean) => void;
  /** Values of an earlier clone to retry: the form opens filled with them. */
  initialValues?: { cloneUrl: string; destinationPath: string; name?: string };
}

/** The repository a retried clone names, from its clone URL. */
function repoFromCloneUrl(cloneUrl: string, name?: string): GitHubRepo {
  const path = cloneUrl
    .replace(/\.git$/, '')
    .replace(/^[a-z]+:\/\/[^/]+\//i, '')
    .replace(/^[^@]+@[^:]+:/, '');
  const fullName = path || name || cloneUrl;
  const [owner = '', repoName = fullName] = fullName.split('/');
  return {
    id: 0,
    full_name: fullName,
    name: repoName,
    description: null,
    private: false,
    html_url: cloneUrl.replace(/\.git$/, ''),
    clone_url: cloneUrl,
    language: null,
    updated_at: '',
    stargazers_count: 0,
    default_branch: '',
    owner: { login: owner, avatar_url: '' },
  };
}

export function CloneRepoView({ onCloningChange, initialValues }: CloneRepoViewProps = {}) {
  const { t } = useTranslation();
  const now = useMinuteTick();
  const navigate = useNavigate();
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const setAddProjectOpen = useUIStore((s) => s.setAddProjectOpen);
  const generalSettingsOpen = useUIStore((s) => s.generalSettingsOpen);

  const [view, setView] = useState<ViewState>('checking');

  useEffect(() => {
    onCloningChange?.(view === 'cloning');
  }, [view, onCloningChange]);
  const [ghUser, setGhUser] = useState<{
    login: string;
    avatar_url: string;
    name: string | null;
  } | null>(null);
  const [tokenSource, setTokenSource] = useState<'profile' | 'cli' | null>(null);

  // Device flow state
  const [_deviceCode, setDeviceCode] = useState('');
  const [userCode, setUserCode] = useState('');
  const [verificationUri, setVerificationUri] = useState('');
  const [_pollInterval, setPollInterval] = useState(5);
  const [codeCopied, copyCode] = useCopyToClipboard();
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Repos state
  const repoList = useRepoListState();
  const {
    repos,
    setRepos,
    search,
    setSearch,
    debouncedSearch,
    loadingRepos,
    highlightedIndex,
    setHighlightedIndex,
    listRef,
    sentinelRef,
  } = repoList;

  // Clone config state
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(() =>
    initialValues ? repoFromCloneUrl(initialValues.cloneUrl, initialValues.name) : null,
  );
  const [destinationPath, setDestinationPath] = useState(initialValues?.destinationPath ?? '');
  const [projectName, setProjectName] = useState(
    () =>
      initialValues?.name ?? (initialValues ? repoFromCloneUrl(initialValues.cloneUrl).name : ''),
  );
  const retryingRef = useRef(!!initialValues);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [_isCloning, setIsCloning] = useState(false);

  // Clone progress from WebSocket
  const {
    clonePhase,
    setClonePhase,
    clonePercent,
    setClonePercent,
    phaseChanged,
    activeCloneIdRef,
  } = useCloneProgress({ t, navigate, loadProjects, setAddProjectOpen, setIsCloning, setView });

  const loadGhUser = useCallback(async () => {
    const result = await api.githubUser();
    if (result.isOk()) {
      setGhUser(result.value);
    }
  }, []);

  // The state updates run when the status request settles, never synchronously
  // in the effects that call this.
  const checkConnection = useCallback(async () => {
    return api.githubStatus().then(async (result) => {
      if (result.isOk()) {
        if (result.value.connected) {
          setTokenSource(result.value.source ?? 'profile');
          await loadGhUser();
          // A retried clone goes straight to its filled form.
          setView(retryingRef.current ? 'clone-config' : 'repos');
          retryingRef.current = false;
        } else {
          setTokenSource(null);
          setView('connect');
        }
      } else {
        // API call itself failed (network error, server down, etc.)
        setView('error');
      }
    });
  }, [loadGhUser]);

  // Check initial connection status
  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  // Re-check when general settings dialog closes (user may have added a token)
  useEffect(() => {
    if (!generalSettingsOpen && (view === 'connect' || view === 'error')) {
      checkConnection();
    }
  }, [generalSettingsOpen, view, checkConnection]);

  const selectRepo = (repo: GitHubRepo) => {
    setSelectedRepo(repo);
    setProjectName(repo.name);
    setView('clone-config');
  };
  const { handleSearchKeyDown } = useRepoFeed(view, repoList, selectRepo);

  // Cleanup poll timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // ── Start Device Flow ──────────────────────────

  const startDeviceFlow = async () => {
    const result = await api.githubStartDevice();
    if (result.isErr()) {
      toastError(result.error, 'cloneRepo');
      return;
    }

    const data = result.value;
    setDeviceCode(data.device_code);
    setUserCode(data.user_code);
    setVerificationUri(data.verification_uri);
    setPollInterval(data.interval);
    setView('device-flow');

    // Start polling
    startPolling(data.device_code, data.interval);
  };

  const startPolling = (code: string, interval: number) => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    pollTimerRef.current = setInterval(
      async () => {
        const result = await api.githubPoll(code);
        if (result.isErr()) return;

        const data = result.value;
        if (data.status === 'success') {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          await loadGhUser();
          setView('repos');
          toast.success(t('github.connected', { login: '' }));
        } else if (data.status === 'expired' || data.status === 'denied') {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          toast.error(
            data.status === 'expired'
              ? t('github.deviceFlow.expired')
              : t('github.deviceFlow.denied'),
          );
          setView('connect');
        } else if (data.interval) {
          // slow_down: increase interval
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          startPolling(code, data.interval);
        }
      },
      (interval + 1) * 1000,
    );
  };

  // ── Clone repo ─────────────────────────────────

  const handleClone = async () => {
    if (!selectedRepo || !destinationPath || !projectName) return;
    setIsCloning(true);
    setClonePhase('');
    setClonePercent(undefined);
    setView('cloning');

    // Chosen here, so events that arrive before the response still match.
    const cloneId = crypto.randomUUID();
    activeCloneIdRef.current = cloneId;
    const result = await api.cloneRepo(
      selectedRepo.clone_url,
      destinationPath,
      projectName,
      cloneId,
    );
    if (result.isErr()) {
      activeCloneIdRef.current = null;
      toastError(result.error, 'cloneRepo');
      setIsCloning(false);
      setView('clone-config');
    }
    // Success and failure arrive as the clone's last `clone:progress` event.
  };

  // ── Disconnect ─────────────────────────────────

  const disconnect = async () => {
    await api.githubDisconnect();
    setGhUser(null);
    setRepos([]);
    setView('connect');
    toast.success(t('github.disconnected'));
  };

  // ── Render ─────────────────────────────────────

  // Loading / Checking state
  if (view === 'checking') {
    return <LoadingState padding="lg" fill={false} testId="clone-repo-checking" />;
  }

  // Error state — API call failed (network error, server down, etc.)
  if (view === 'error') {
    return (
      <ConnectionErrorView
        onRetry={() => {
          setView('checking');
          checkConnection();
        }}
      />
    );
  }

  // Connect state
  if (view === 'connect') {
    return (
      <ConnectGithubView
        onConnect={startDeviceFlow}
        onUseToken={() => navigate(buildPath('/preferences/github'))}
      />
    );
  }

  // Device Flow state
  if (view === 'device-flow') {
    return (
      <DeviceFlowView
        userCode={userCode}
        verificationUri={verificationUri}
        codeCopied={codeCopied}
        onCopyCode={() => copyCode(userCode)}
        onCancel={() => {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setView('connect');
        }}
      />
    );
  }

  // Repo browser state
  if (view === 'repos') {
    return (
      <RepoBrowser
        ghUser={ghUser}
        tokenSource={tokenSource}
        onDisconnect={disconnect}
        search={search}
        onSearchChange={setSearch}
        debouncedSearch={debouncedSearch}
        onSearchKeyDown={handleSearchKeyDown}
        repos={repos}
        loadingRepos={loadingRepos}
        highlightedIndex={highlightedIndex}
        onHighlight={setHighlightedIndex}
        onSelect={selectRepo}
        listRef={listRef}
        sentinelRef={sentinelRef}
        now={now}
      />
    );
  }

  // Clone config state
  if (view === 'clone-config' && selectedRepo) {
    return (
      <CloneConfigForm
        selectedRepo={selectedRepo}
        projectName={projectName}
        onProjectNameChange={setProjectName}
        destinationPath={destinationPath}
        onDestinationPathChange={setDestinationPath}
        folderPickerOpen={folderPickerOpen}
        onFolderPickerOpenChange={setFolderPickerOpen}
        onBack={() => setView('repos')}
        onClone={handleClone}
      />
    );
  }

  // Cloning state
  if (view === 'cloning') {
    return (
      <CloneProgressView
        repoFullName={selectedRepo?.full_name}
        clonePhase={clonePhase}
        clonePercent={clonePercent}
        phaseChanged={phaseChanged}
      />
    );
  }

  return null;
}
