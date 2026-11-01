import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { systemApi, type ProviderSetupStatus } from '@/lib/api/system';
import { openProviderLoginTerminal } from '@/lib/open-terminal-tab';
import { useRunnerProvidersStore } from '@/stores/runner-providers-store';

const descriptions: Record<ProviderSetupStatus['state'], string> = {
  missing: 'No executable was found on this runner. Install it to continue setup.',
  bundled:
    'An integrated SDK is available. You can install the standalone CLI for terminal login and troubleshooting.',
  installed: 'The executable is installed on this runner.',
  installing: 'Installing on the runner… You can close this dialog; installation will continue.',
  failed: 'Installation did not complete. You can retry.',
  manual:
    'This provider requires manual setup. Follow its installation instructions on the runner or configure its extension in Settings → Providers.',
};

function authDescription(auth: ProviderSetupStatus['auth']): string {
  if (auth === 'connected') return 'Connected. You can return to your message.';
  if (auth === 'configured') return 'Credentials are configured. You can return to your message.';
  if (auth === 'required')
    return 'Sign in to continue. Funny will open the login process in its terminal.';
  return 'Open the terminal to sign in. This provider does not support automatic session verification.';
}

export function ProviderSetupDialog({
  provider,
  label,
  projectId,
  onClose,
  reauthenticate = false,
}: {
  provider: string;
  label: string;
  projectId?: string | null;
  onClose: () => void;
  reauthenticate?: boolean;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ProviderSetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const result = await systemApi.providerSetupStatus(provider, projectId);
      if (cancelled) return;
      if (result.isErr()) {
        setError(result.error.message);
        return;
      }
      setError(null);
      setStatus(result.value);
      if (result.value.state === 'installing') timer = setTimeout(poll, 1500);
      if (result.value.state === 'installed') void useRunnerProvidersStore.getState().fetch(true);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [provider, projectId, revision]);

  async function install() {
    setPending(true);
    setError(null);
    const result = await systemApi.installProviderTool(provider, projectId);
    setPending(false);
    if (result.isErr()) {
      setError(result.error.message);
      return;
    }
    setStatus(result.value);
    setRevision((value) => value + 1);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Configure {label}</DialogTitle>
          <DialogDescription>
            Check and install this provider on your project’s runner.
          </DialogDescription>
        </DialogHeader>
        <p role="status" className="text-sm">
          {status ? descriptions[status.state] : 'Checking runner…'}
        </p>
        {(error || status?.error) && (
          <p role="alert" className="text-destructive text-sm">
            {error || status?.error}
          </p>
        )}
        {status?.state === 'installed' && (
          <p className="text-sm">
            {reauthenticate ? t('thread.providerAuthExpired') : authDescription(status.auth)}
          </p>
        )}
        {provider === 'pi' && (reauthenticate || status?.auth === 'required') && (
          <p className="text-sm">
            {status?.loginCommand
              ? 'Connect Pi, then type /login in the terminal and choose your provider. After signing in, return to your message.'
              : 'Install Pi to sign in, then connect and type /login in the terminal to choose your provider.'}
          </p>
        )}
        <SetupActions
          status={status}
          pending={pending}
          projectId={projectId}
          label={label}
          reauthenticate={reauthenticate}
          onCheck={() => setRevision((value) => value + 1)}
          onInstall={install}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

function SetupActions({
  status,
  pending,
  projectId,
  label,
  reauthenticate,
  onCheck,
  onInstall,
  onClose,
}: {
  status: ProviderSetupStatus | null;
  pending: boolean;
  projectId?: string | null;
  label: string;
  reauthenticate: boolean;
  onCheck: () => void;
  onInstall: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" disabled={pending} onClick={onCheck}>
        Check again
      </Button>
      {status?.loginCommand &&
        projectId &&
        (reauthenticate || (status.auth !== 'connected' && status.auth !== 'configured')) && (
          <Button
            onClick={() => {
              openProviderLoginTerminal({
                projectId,
                command: status.loginCommand!,
                shell: status.loginShell ?? 'default',
                label: `Connect ${label}`,
              });
              onClose();
            }}
          >
            Connect {label}
          </Button>
        )}
      <InstallAction status={status} pending={pending} onInstall={onInstall} />
    </div>
  );
}

function InstallAction({
  status,
  pending,
  onInstall,
}: {
  status: ProviderSetupStatus | null;
  pending: boolean;
  onInstall: () => Promise<void>;
}) {
  if (!status?.installable || status.state === 'installed') return null;
  const installing = pending || status.state === 'installing';
  const label = status.state === 'failed' ? 'Retry installation' : 'Install on runner';
  return (
    <Button disabled={installing} onClick={() => void onInstall()}>
      {installing ? 'Installing…' : label}
    </Button>
  );
}
