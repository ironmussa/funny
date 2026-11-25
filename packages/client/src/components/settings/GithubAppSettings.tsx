import { Check, ChevronsUpDown } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api';
import type { GithubAppAccount, GithubAppStatus } from '@/lib/api/github-app';
import { cn } from '@/lib/utils';

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
      <PermissionNotices status={status} />
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

/**
 * What keeps the issue factory from publishing its regression proof check: a
 * permission the App lacks, or an installation that has not accepted it yet.
 */
function PermissionNotices({ status }: { status: GithubAppStatus }) {
  const missing = status.missingPermissions ?? [];
  const pending = status.pendingInstallations ?? [];
  if (missing.length === 0 && pending.length === 0) return null;
  const settingsLink = status.settingsUrl ? (
    <a
      href={status.settingsUrl}
      target="_blank"
      rel="noreferrer"
      className="ml-1 underline"
      data-testid="github-app-missing-permissions-settings"
    >
      Open the App’s settings
    </a>
  ) : null;
  return (
    <>
      {missing.length > 0 && (
        <Alert data-testid="github-app-missing-permissions">
          <AlertDescription>
            <div className="space-y-1 text-xs">
              <p>
                The App lacks {missing.join(', ')}. The issue factory needs
                <code className="mx-1">checks: write</code>to publish its regression proof check,
                and never enables auto-merge without it.
              </p>
              <p>
                Add it under Permissions in the App’s settings, then accept the new permission on
                each installation.
                {settingsLink}
              </p>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {missing.length === 0 && pending.length > 0 && (
        <Alert data-testid="github-app-pending-installations">
          <AlertDescription>
            <div className="space-y-1 text-xs">
              <p>
                These installations have not accepted the App’s current permissions:{' '}
                {pending.join(', ')}. Until their owner accepts them, the issue factory cannot
                publish its regression proof check there and never enables auto-merge.
              </p>
              <p>
                The owner accepts them from the installation’s page on GitHub (Settings &gt;
                Applications &gt; Installed GitHub Apps).
              </p>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </>
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
        <TargetCombobox accounts={accounts} choice={choice} onChoice={onChoice} onOrg={onOrg} />
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

/**
 * What the target picker shows: its labels, the listed organizations, and
 * whether the search names an organization that is not listed (offered as
 * typed).
 */
function targetView(accounts: GithubAppAccount[], choice: Choice, search: string) {
  const personal = accounts.find((a) => a.type === 'user');
  const orgs = accounts.filter((a) => a.type === 'org');
  const personalLabel = personal ? `${personal.login} (personal account)` : 'Personal account';
  const otherLabel = orgs.length > 0 ? 'Another organization…' : 'An organization…';
  const labels = new Map([
    ['user', personalLabel],
    ['other', otherLabel],
  ]);
  const label = labels.get(choice) ?? choice.slice(4);
  const typed = search.trim();
  const typedIsListed = orgs.some((a) => a.login.toLowerCase() === typed.toLowerCase());
  const offerTyped = typed !== '' && !typedIsListed && personal?.login !== typed;
  return { orgs, personalLabel, otherLabel, label, typed, offerTyped };
}

/**
 * Where to create the App: the personal account, one of the admin's
 * organizations (searchable, an admin may have many), or another one typed by
 * hand. A search that matches no listed organization offers to use it as typed.
 */
function TargetCombobox({
  accounts,
  choice,
  onChoice,
  onOrg,
}: {
  accounts: GithubAppAccount[];
  choice: Choice;
  onChoice: (choice: Choice) => void;
  onOrg: (org: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const listId = useId();
  const { orgs, personalLabel, otherLabel, label, typed, offerTyped } = targetView(
    accounts,
    choice,
    search,
  );

  const pick = (next: Choice) => {
    onChoice(next);
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          className="w-64 justify-between"
          data-testid="github-app-target"
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="icon-xs ml-1 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent padding="none" className="w-64" align="start">
        <Command>
          <CommandInput
            placeholder="Search organizations…"
            value={search}
            onValueChange={setSearch}
            data-testid="github-app-target-search"
          />
          <CommandList id={listId}>
            <CommandGroup>
              <TargetItem
                value={personalLabel}
                selected={choice === 'user'}
                onSelect={() => pick('user')}
                testId="github-app-target-user"
              />
              {orgs.map((a) => (
                <TargetItem
                  key={a.login}
                  value={a.login}
                  selected={choice === `org:${a.login}`}
                  onSelect={() => pick(`org:${a.login}`)}
                  testId={`github-app-target-org-${a.login}`}
                />
              ))}
              <CommandItem
                forceMount
                value={`__other__ ${typed}`}
                onSelect={() => {
                  onOrg(offerTyped ? typed : '');
                  pick('other');
                }}
                data-testid="github-app-target-other"
              >
                <Check
                  className={cn('mr-2 h-3 w-3', choice === 'other' ? 'opacity-100' : 'opacity-0')}
                />
                {offerTyped ? `Use organization “${typed}”` : otherLabel}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function TargetItem({
  value,
  selected,
  onSelect,
  testId,
}: {
  value: string;
  selected: boolean;
  onSelect: () => void;
  testId: string;
}) {
  return (
    <CommandItem value={value} onSelect={onSelect} data-testid={testId}>
      <Check className={cn('mr-2 h-3 w-3', selected ? 'opacity-100' : 'opacity-0')} />
      <span className="truncate">{value}</span>
    </CommandItem>
  );
}
