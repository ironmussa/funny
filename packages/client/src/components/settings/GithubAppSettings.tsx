import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import type { GithubAppStatus } from '@/lib/api/github-app';

/**
 * The deployment's GitHub App (sandbox-github-app-tokens). Sandboxes get
 * short-lived tokens for one repository from it, never the owner's PAT. The
 * admin connects it with GitHub's manifest flow: funny posts a pre-filled App
 * to GitHub, GitHub creates it and sends the admin back here.
 */
export function GithubAppSettings() {
  const [status, setStatus] = useState<GithubAppStatus | null>(null);
  const [target, setTarget] = useState<'user' | 'org'>('org');
  const [org, setOrg] = useState('');
  const [busy, setBusy] = useState(false);
  const [manifest, setManifest] = useState<{ action: string; manifest: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const load = useCallback(async () => {
    const result = await api.getGithubAppStatus();
    setStatus(result.isOk() ? result.value : { configured: false, source: 'none' });
  }, []);

  useEffect(() => {
    void load();
    const outcome = new URLSearchParams(window.location.search).get('githubApp');
    if (outcome === 'connected')
      toast.success('GitHub App connected. Now install it on repositories.');
    if (outcome === 'error') toast.error('GitHub did not create the App. Try again.');
  }, [load]);

  // GitHub expects the manifest as a form POST; submit once it is rendered.
  useEffect(() => {
    if (manifest) formRef.current?.submit();
  }, [manifest]);

  const connect = async () => {
    setBusy(true);
    const result = await api.startGithubAppManifest(
      target === 'org' ? { target, org: org.trim() } : { target },
    );
    if (result.isErr()) {
      setBusy(false);
      toast.error('Could not start the GitHub App setup');
      return;
    }
    setManifest({ action: result.value.action, manifest: result.value.manifest });
  };

  const disconnect = async () => {
    setBusy(true);
    const result = await api.disconnectGithubApp();
    setBusy(false);
    if (result.isErr()) {
      toast.error('Could not disconnect the GitHub App');
      return;
    }
    toast.success('GitHub App disconnected. Delete it on GitHub too.');
    void load();
  };

  if (!status) return <LoadingState />;

  return (
    <div className="space-y-4" data-testid="github-app-settings">
      <div>
        <h3 className="text-sm font-semibold">GitHub App</h3>
        <p className="text-muted-foreground text-xs">
          Sandboxes use it to get a token for one repository, valid for an hour, so your personal
          access token never enters a sandbox. git and gh work as usual.
        </p>
      </div>

      {status.configured ? (
        <ConnectedApp status={status} busy={busy} onDisconnect={disconnect} />
      ) : (
        <ConnectForm
          error={status.error}
          target={target}
          org={org}
          busy={busy}
          onTarget={setTarget}
          onOrg={setOrg}
          onConnect={connect}
        />
      )}

      {manifest && (
        <form ref={formRef} method="post" action={manifest.action} className="hidden">
          <input type="hidden" name="manifest" value={manifest.manifest} />
        </form>
      )}
    </div>
  );
}

function ConnectedApp({
  status,
  busy,
  onDisconnect,
}: {
  status: GithubAppStatus;
  busy: boolean;
  onDisconnect: () => void;
}) {
  const fromEnvironment = status.source === 'environment';
  return (
    <div
      className="border-border/50 space-y-3 rounded-lg border p-4"
      data-testid="github-app-connected"
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{status.slug ?? `App ${status.appId}`}</span>
        <Badge variant="secondary" data-testid="github-app-source">
          {fromEnvironment ? 'Server variables' : 'Connected'}
        </Badge>
      </div>
      {status.owner && <p className="text-muted-foreground text-xs">Owned by {status.owner}</p>}
      <p className="text-muted-foreground text-xs">
        Install it on the repositories sandboxes will work on. Choose “Only select repositories”.
      </p>
      <div className="flex gap-2">
        {status.installUrl && (
          <Button asChild size="sm" data-testid="github-app-install">
            <a href={status.installUrl} target="_blank" rel="noreferrer">
              Install on repositories
            </a>
          </Button>
        )}
        {!fromEnvironment && (
          <Button
            size="sm"
            variant="outline"
            onClick={onDisconnect}
            disabled={busy}
            data-testid="github-app-disconnect"
          >
            Disconnect
          </Button>
        )}
      </div>
      {fromEnvironment && (
        <p className="text-muted-foreground text-xs">
          Configured through GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY on the server.
        </p>
      )}
    </div>
  );
}

function ConnectForm({
  error,
  target,
  org,
  busy,
  onTarget,
  onOrg,
  onConnect,
}: {
  error?: string;
  target: 'user' | 'org';
  org: string;
  busy: boolean;
  onTarget: (target: 'user' | 'org') => void;
  onOrg: (org: string) => void;
  onConnect: () => void;
}) {
  return (
    <div
      className="border-border/50 space-y-3 rounded-lg border p-4"
      data-testid="github-app-connect-form"
    >
      {error && (
        <p className="text-destructive text-xs" data-testid="github-app-error">
          {error}
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        GitHub will show a pre-filled App to create. You can change its name there.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={target} onValueChange={(v) => onTarget(v as 'user' | 'org')}>
          <SelectTrigger className="w-48" data-testid="github-app-target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="org">Organization</SelectItem>
            <SelectItem value="user">Personal account</SelectItem>
          </SelectContent>
        </Select>
        {target === 'org' && (
          <Input
            className="w-56"
            placeholder="organization"
            value={org}
            onChange={(e) => onOrg(e.target.value)}
            data-testid="github-app-org"
          />
        )}
        <Button
          size="sm"
          onClick={onConnect}
          disabled={busy || (target === 'org' && !org.trim())}
          data-testid="github-app-connect"
        >
          Connect GitHub
        </Button>
      </div>
    </div>
  );
}
