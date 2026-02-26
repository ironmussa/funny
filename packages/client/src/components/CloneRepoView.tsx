import type { GitHubRepo } from '@funny/shared';
import {
  Github,
  Copy,
  ExternalLink,
  Loader2,
  Search,
  Lock,
  Globe,
  ArrowLeft,
  FolderOpen,
  Check,
  LogOut,
} from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';

import { FolderPicker } from './FolderPicker';

type ViewState = 'checking' | 'connect' | 'device-flow' | 'repos' | 'clone-config' | 'cloning';

export function CloneRepoView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const loadProjects = useAppStore((s) => s.loadProjects);
  const setAddProjectOpen = useAppStore((s) => s.setAddProjectOpen);

  const [view, setView] = useState<ViewState>('checking');
  const [ghUser, setGhUser] = useState<{
    login: string;
    avatar_url: string;
    name: string | null;
  } | null>(null);

  // Device flow state
  const [_deviceCode, setDeviceCode] = useState('');
  const [userCode, setUserCode] = useState('');
  const [verificationUri, setVerificationUri] = useState('');
  const [_pollInterval, setPollInterval] = useState(5);
  const [codeCopied, setCodeCopied] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Repos state
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);

  // Clone config state
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [destinationPath, setDestinationPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [_isCloning, setIsCloning] = useState(false);

  // Search debounce
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check initial connection status
  useEffect(() => {
    (async () => {
      const result = await api.githubStatus();
      if (result.isOk() && result.value.connected) {
        await loadGhUser();
        setView('repos');
      } else {
        setView('connect');
      }
    })();
  }, []);

  const loadGhUser = async () => {
    const result = await api.githubUser();
    if (result.isOk()) {
      setGhUser(result.value);
    }
  };

  // Load repos
  const fetchRepos = useCallback(async (searchQuery: string, pageNum: number, append = false) => {
    setLoadingRepos(true);
    const result = await api.githubRepos({
      page: pageNum,
      per_page: 30,
      search: searchQuery || undefined,
      sort: 'updated',
    });
    if (result.isOk()) {
      setRepos((prev) => (append ? [...prev, ...result.value.repos] : result.value.repos));
      setHasMore(result.value.hasMore);
    }
    setLoadingRepos(false);
  }, []);

  // Load repos when entering repo view
  useEffect(() => {
    if (view === 'repos') {
      fetchRepos('', 1);
    }
  }, [view, fetchRepos]);

  // Debounced search
  useEffect(() => {
    if (view !== 'repos') return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setPage(1);
      fetchRepos(search, 1);
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search, view, fetchRepos]);

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
      toast.error(result.error.message);
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

  // ── Copy user code ─────────────────────────────

  const copyCode = () => {
    navigator.clipboard.writeText(userCode);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };

  // ── Select repo for cloning ────────────────────

  const selectRepo = (repo: GitHubRepo) => {
    setSelectedRepo(repo);
    setProjectName(repo.name);
    setView('clone-config');
  };

  // ── Clone repo ─────────────────────────────────

  const handleClone = async () => {
    if (!selectedRepo || !destinationPath || !projectName) return;
    setIsCloning(true);
    setView('cloning');

    const result = await api.cloneRepo(selectedRepo.clone_url, destinationPath, projectName);
    if (result.isErr()) {
      toast.error(result.error.message);
      setIsCloning(false);
      setView('clone-config');
      return;
    }

    toast.success(t('github.clone.success'));
    await loadProjects();
    setAddProjectOpen(false);
    navigate(`/projects/${result.value.id}`);
  };

  // ── Disconnect ─────────────────────────────────

  const disconnect = async () => {
    await api.githubDisconnect();
    setGhUser(null);
    setRepos([]);
    setView('connect');
    toast.success(t('github.disconnected'));
  };

  // ── Format relative time ───────────────────────

  const relativeTime = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return t('time.minutes', { count: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('time.hours', { count: hours });
    const days = Math.floor(hours / 24);
    if (days < 30) return t('time.days', { count: days });
    return t('time.months', { count: Math.floor(days / 30) });
  };

  // ── Render ─────────────────────────────────────

  // Loading / Checking state
  if (view === 'checking') {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Connect state
  if (view === 'connect') {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Github className="h-6 w-6" />
        </div>
        <div className="space-y-1 text-center">
          <h3 className="font-medium">{t('github.connectGithub')}</h3>
          <p className="max-w-xs text-sm text-muted-foreground">{t('github.connectDesc')}</p>
        </div>
        <Button onClick={startDeviceFlow}>
          <Github className="mr-2 h-4 w-4" />
          {t('github.connectGithub')}
        </Button>
      </div>
    );
  }

  // Device Flow state
  if (view === 'device-flow') {
    return (
      <div className="flex flex-col items-center gap-5 py-8">
        <div className="space-y-1 text-center">
          <h3 className="font-medium">{t('github.deviceFlow.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('github.deviceFlow.desc')}</p>
        </div>

        {/* User code display */}
        <div className="flex items-center gap-2">
          <code className="rounded-md bg-muted px-4 py-2 font-mono text-2xl font-bold tracking-widest">
            {userCode}
          </code>
          <Button variant="outline" size="sm" onClick={copyCode}>
            {codeCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.open(verificationUri, '_blank')}>
            <ExternalLink className="mr-2 h-4 w-4" />
            {t('github.deviceFlow.openGithub')}
          </Button>
        </div>

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('github.deviceFlow.waitingAuth')}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setView('connect');
          }}
        >
          {t('common.cancel')}
        </Button>
      </div>
    );
  }

  // Repo browser state
  if (view === 'repos') {
    return (
      <div className="flex h-full flex-col">
        {/* Header with user info */}
        {ghUser && (
          <div className="mb-3 flex items-center gap-2">
            <img src={ghUser.avatar_url} alt={ghUser.login} className="h-6 w-6 rounded-full" />
            <span className="text-sm font-medium">{ghUser.login}</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 text-xs text-muted-foreground"
              onClick={disconnect}
            >
              <LogOut className="mr-1 h-3 w-3" />
              {t('github.disconnect')}
            </Button>
          </div>
        )}

        {/* Search */}
        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-auto w-full py-1.5 pl-8 pr-3"
            placeholder={t('github.repos.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Repo list */}
        <ScrollArea className="-mx-1 flex-1">
          {repos.map((repo) => (
            <button
              key={repo.id}
              onClick={() => selectRepo(repo)}
              className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent"
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{repo.full_name}</span>
                {repo.private ? (
                  <Lock className="h-3 w-3 flex-shrink-0 text-status-pending" />
                ) : (
                  <Globe className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                )}
              </div>
              {repo.description && (
                <p className="truncate text-xs text-muted-foreground">{repo.description}</p>
              )}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {repo.language && <span>{repo.language}</span>}
                <span>{relativeTime(repo.updated_at)}</span>
              </div>
            </button>
          ))}

          {loadingRepos && (
            <div className="flex justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loadingRepos && repos.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('github.repos.noRepos')}
            </p>
          )}

          {hasMore && !loadingRepos && (
            <div className="flex justify-center py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const nextPage = page + 1;
                  setPage(nextPage);
                  fetchRepos(search, nextPage, true);
                }}
              >
                {t('github.repos.loadMore')}
              </Button>
            </div>
          )}
        </ScrollArea>
      </div>
    );
  }

  // Clone config state
  if (view === 'clone-config' && selectedRepo) {
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground"
          onClick={() => setView('repos')}
        >
          <ArrowLeft className="mr-1 h-3.5 w-3.5" />
          {t('github.repos.title')}
        </Button>

        {/* Selected repo */}
        <div className="space-y-1 rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{selectedRepo.full_name}</span>
            {selectedRepo.private && <Lock className="h-3 w-3 text-status-pending" />}
          </div>
          {selectedRepo.description && (
            <p className="text-xs text-muted-foreground">{selectedRepo.description}</p>
          )}
        </div>

        {/* Destination path */}
        <div>
          <label className="mb-1.5 block text-sm font-medium">
            {t('github.clone.destination')}
          </label>
          <div className="flex gap-2">
            <Input
              className="flex-1"
              placeholder={t('github.clone.destinationDesc')}
              value={destinationPath}
              onChange={(e) => setDestinationPath(e.target.value)}
            />
            <Button variant="outline" size="sm" onClick={() => setFolderPickerOpen(true)}>
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Project name */}
        <div>
          <label className="mb-1.5 block text-sm font-medium">
            {t('github.clone.projectName')}
          </label>
          <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} />
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button variant="outline" className="flex-1" onClick={() => setView('repos')}>
            {t('common.cancel')}
          </Button>
          <Button
            className="flex-1"
            onClick={handleClone}
            disabled={!destinationPath || !projectName}
          >
            {t('github.clone.cloneAndCreate')}
          </Button>
        </div>

        {folderPickerOpen && (
          <FolderPicker
            onSelect={(path) => {
              setDestinationPath(path);
              setFolderPickerOpen(false);
            }}
            onClose={() => setFolderPickerOpen(false)}
          />
        )}
      </div>
    );
  }

  // Cloning state
  if (view === 'cloning') {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">
          {t('github.clone.cloning', { repo: selectedRepo?.full_name })}
        </p>
      </div>
    );
  }

  return null;
}
