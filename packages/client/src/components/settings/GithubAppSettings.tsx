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
import type { GithubAppAccount, GithubAppStatus } from '@/lib/api/github-app';

/** The connect form's choice: the personal account, an organization, or one typed by hand. */
type Choice = 'user' | `org:${string}` | 'other';

/** What the manifest flow is started for: the personal account or an organization. */
function manifestTarget(choice: Choice, org: string) {
  if (choice === 'user') return { target: 'user' as const };
  return { target: 'org' as const, org: choice === 'other' ? org.trim() : choice.slice(4) };
}

/**
 * The App's status and, while none is connected, the accounts the admin can
 * create it under. Reports the outcome GitHub sent the admin back with.
 */
function useGithubAppState() {
  const [status, setStatus] = useState<GithubAppStatus | null>(null);
  const [accounts, setAccounts] = useState<GithubAppAccount[] | null>(null);
  const [hasToken, setHasToken] = useState(false);

  const load = useCallback(async () => {
    const result = await api.getGithubAppStatus();
    const next = result.isOk() ? result.value : { configured: false, source: 'none' as const };
    setStatus(next);
    if (next.configured) return;
    const listed = await api.getGithubAppAccounts();
    setAccounts(listed.isOk() ? listed.value.accounts : []);
    setHasToken(listed.isOk() && listed.value.hasToken);
  }, []);

  useEffect(() => {
    void load();
    const outcome = new URLSearchParams(window.location.search).get('githubApp');
    if (outcome === 'installed') toast.success('GitHub App connected and installed.');
    if (outcome === 'error') toast.error('GitHub did not create the App. Try again.');
  }, [load]);

  return { status, accounts, hasToken, reload: load };
}

/**
 * The deployment's GitHub App (sandbox-github-app-tokens). Sandboxes get
 * short-lived tokens for one repository from it, never the owner's PAT. The
 * admin connects it with GitHub's manifest flow: funny posts a pre-filled App
 * to GitHub, GitHub creates it and sends the admin on to install it, then back
 * here. With a GitHub token in their profile the admin picks the account from
 * a list instead of typing an organization name.
 */
export function GithubAppSettings() {
  const { status, accounts, hasToken, reload } = useGithubAppState();
  const [choice, setChoice] = useState<Choice>('user');
  const [org, setOrg] = useState('');
  const [busy, setBusy] = useState(false);
  const [manifest, setManifest] = useState<{ action: string; manifest: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // GitHub expects the manifest as a form POST; submit once it is rendered.
  useEffect(() => {
    if (manifest) formRef.current?.submit();
  }, [manifest]);

  const connect = async () => {
    setBusy(true);
    const result = await api.startGithubAppManifest(manifestTarget(choice, org));
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
    void reload();
  };

  if (!status || (!status.configured && !accounts)) return <LoadingState />;

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
          accounts={accounts ?? []}
          hasToken={hasToken}
          choice={choice}
          org={org}
          busy={busy}
          onChoice={setChoice}
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
  accounts,
  hasToken,
  choice,
  org,
  busy,
  onChoice,
  onOrg,
  onConnect,
}: {
  error?: string;
  accounts: GithubAppAccount[];
  hasToken: boolean;
  choice: Choice;
  org: string;
  busy: boolean;
  onChoice: (choice: Choice) => void;
  onOrg: (org: string) => void;
  onConnect: () => void;
}) {
  const personal = accounts.find((a) => a.type === 'user');
  const orgs = accounts.filter((a) => a.type === 'org');
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
      <ol className="text-muted-foreground list-inside list-decimal space-y-0.5 text-xs">
        <li>Choose where to create the App. GitHub shows it pre-filled; you can rename it.</li>
        <li>GitHub then asks which repositories to install it on. Pick only the ones you need.</li>
        <li>You come back here, done.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={choice} onValueChange={(v) => onChoice(v as Choice)}>
          <SelectTrigger className="w-64" data-testid="github-app-target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="user" data-testid="github-app-target-user">
              {personal ? `${personal.login} (personal account)` : 'Personal account'}
            </SelectItem>
            {orgs.map((a) => (
              <SelectItem
                key={a.login}
                value={`org:${a.login}`}
                data-testid={`github-app-target-org-${a.login}`}
              >
                {a.login}
              </SelectItem>
            ))}
            <SelectItem value="other" data-testid="github-app-target-other">
              {orgs.length > 0 ? 'Another organization…' : 'An organization…'}
            </SelectItem>
          </SelectContent>
        </Select>
        {choice === 'other' && (
          <Input
            className="w-56"
            placeholder="Organization name, as in github.com/<name>"
            value={org}
            onChange={(e) => onOrg(e.target.value)}
            data-testid="github-app-org"
          />
        )}
        <Button
          size="sm"
          onClick={onConnect}
          disabled={busy || (choice === 'other' && !org.trim())}
          data-testid="github-app-connect"
        >
          Connect GitHub
        </Button>
      </div>
      {!hasToken && (
        <p className="text-muted-foreground text-xs" data-testid="github-app-token-hint">
          Save a GitHub token in Settings &gt; Profile to pick your organizations from this list.
        </p>
      )}
    </div>
  );
}
