import { Github, Globe, Link2, Loader2, Lock } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { cn } from '@/lib/utils';

const log = createClientLogger('publish-repo-dialog');

const REMOTE_URL_PATTERN = /^(https?:\/\/|git:\/\/|ssh:\/\/|git@[^\s:]+:)/;

interface PublishRepoDialogProps {
  projectId: string;
  /** Directory name used to prefill the repo name */
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful publish or remote-add. `repoUrl` is the new origin URL. */
  onSuccess: (repoUrl: string) => void;
}

export function PublishRepoDialog({
  projectId,
  projectPath,
  open,
  onOpenChange,
  onSuccess,
}: PublishRepoDialogProps) {
  const defaultName = projectPath.split('/').filter(Boolean).pop() ?? '';

  const [tab, setTab] = useState<'github' | 'remote'>('github');

  // ── GitHub publish state ──
  const [repoName, setRepoName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [selectedOrg, setSelectedOrg] = useState('__personal__');
  const [orgs, setOrgs] = useState<string[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Remote URL state ──
  const [remoteUrl, setRemoteUrl] = useState('');
  const [savingRemote, setSavingRemote] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  // Reset everything + fetch orgs when dialog opens
  useEffect(() => {
    if (!open) return;
    setTab('github');
    setRepoName(defaultName);
    setDescription('');
    setIsPrivate(true);
    setSelectedOrg('__personal__');
    setError(null);
    setRemoteUrl('');
    setRemoteError(null);

    const controller = new AbortController();
    setOrgsLoading(true);
    api
      .projectGetGhOrgs(projectId, controller.signal)
      .then((r) => {
        if (r.isOk()) setOrgs(r.value.orgs);
      })
      .then(
        () => setOrgsLoading(false),
        () => setOrgsLoading(false),
      );

    return () => controller.abort();
  }, [open, projectId, defaultName]);

  const handlePublish = useCallback(async () => {
    if (!repoName.trim()) return;
    setPublishing(true);
    setError(null);

    const result = await api.projectPublish(projectId, {
      name: repoName.trim(),
      description: description.trim() || undefined,
      org: selectedOrg === '__personal__' ? undefined : selectedOrg,
      private: isPrivate,
    });

    setPublishing(false);

    if (result.isErr()) {
      const msg = String((result.error as { message?: string })?.message ?? result.error);
      log.warn('publish.github.failed', { projectId, error: msg });
      if (msg.includes('already exists')) {
        setError(`Repository "${repoName}" already exists. Choose a different name.`);
      } else if (msg.includes('GitHub token')) {
        setError('GitHub token required. Set one in Settings > Profile.');
      } else {
        setError(msg);
      }
      return;
    }

    log.info('publish.github.success', { projectId });
    onSuccess(result.value.repoUrl);
  }, [projectId, repoName, description, selectedOrg, isPrivate, onSuccess]);

  const handleSaveRemote = useCallback(async () => {
    const trimmed = remoteUrl.trim();
    if (!trimmed) return;
    if (!REMOTE_URL_PATTERN.test(trimmed)) {
      setRemoteError('URL must start with https://, ssh://, git:// or use the git@host:path form.');
      return;
    }
    setSavingRemote(true);
    setRemoteError(null);

    const result = await api.projectSetRemoteUrl(projectId, trimmed);
    setSavingRemote(false);

    if (result.isErr()) {
      const msg = String((result.error as { message?: string })?.message ?? result.error);
      log.warn('publish.remote.failed', { projectId, error: msg });
      setRemoteError(msg);
      return;
    }

    log.info('publish.remote.success', { projectId });
    onSuccess(trimmed);
  }, [projectId, remoteUrl, onSuccess]);

  const remoteValid = REMOTE_URL_PATTERN.test(remoteUrl.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]" data-testid="publish-repo-dialog">
        <DialogHeader>
          <DialogTitle>Publish Repository</DialogTitle>
          <DialogDescription>
            Create a new GitHub repository or attach this project to an existing remote.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'github' | 'remote')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="github" data-testid="publish-tab-github">
              <Github className="mr-1.5 size-3.5" />
              GitHub
            </TabsTrigger>
            <TabsTrigger value="remote" data-testid="publish-tab-remote">
              <Link2 className="mr-1.5 size-3.5" />
              Remote URL
            </TabsTrigger>
          </TabsList>

          {/* ── GitHub publish tab ── */}
          <TabsContent value="github" className="mt-4">
            <div className="grid gap-4">
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">Owner</label>
                <Select
                  value={selectedOrg}
                  onValueChange={setSelectedOrg}
                  disabled={orgsLoading || publishing}
                >
                  <SelectTrigger data-testid="publish-repo-owner">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__personal__">Personal account</SelectItem>
                    {orgs.map((org) => (
                      <SelectItem key={org} value={org}>
                        {org}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-1.5">
                <label className="text-sm font-medium">Repository name</label>
                <Input
                  data-testid="publish-repo-name"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  placeholder="my-repo"
                  disabled={publishing}
                  autoFocus
                />
              </div>

              <div className="grid gap-1.5">
                <label className="text-sm font-medium">
                  Description <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <Input
                  data-testid="publish-repo-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short description"
                  disabled={publishing}
                />
              </div>

              <div
                className={cn(
                  'flex items-center justify-between rounded-md border px-3 py-2.5',
                  'bg-muted/30',
                )}
              >
                <div className="flex items-center gap-2">
                  {isPrivate ? (
                    <Lock className="size-4 text-muted-foreground" />
                  ) : (
                    <Globe className="size-4 text-muted-foreground" />
                  )}
                  <span className="text-sm">{isPrivate ? 'Private' : 'Public'}</span>
                </div>
                <Switch
                  data-testid="publish-repo-private"
                  checked={isPrivate}
                  onCheckedChange={setIsPrivate}
                  disabled={publishing}
                />
              </div>

              {error && (
                <p className="text-sm text-destructive" data-testid="publish-repo-error">
                  {error}
                </p>
              )}
            </div>
          </TabsContent>

          {/* ── Existing remote URL tab ── */}
          <TabsContent value="remote" className="mt-4">
            <div className="grid gap-4">
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">Remote URL</label>
                <Input
                  data-testid="publish-remote-url"
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  disabled={savingRemote}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Sets <code className="text-foreground">origin</code> on this project. The remote
                  must already exist; create the empty repository on your provider first, then push
                  from the toolbar.
                </p>
              </div>

              {remoteError && (
                <p className="text-sm text-destructive" data-testid="publish-remote-error">
                  {remoteError}
                </p>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={publishing || savingRemote}
            data-testid="publish-repo-cancel"
          >
            Cancel
          </Button>
          {tab === 'github' ? (
            <Button
              onClick={handlePublish}
              disabled={publishing || !repoName.trim()}
              data-testid="publish-repo-submit"
            >
              {publishing && <Loader2 className="mr-2 size-4 animate-spin" />}
              Publish repository
            </Button>
          ) : (
            <Button
              onClick={handleSaveRemote}
              disabled={savingRemote || !remoteValid}
              data-testid="publish-remote-submit"
            >
              {savingRemote && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save remote
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
