import { useEffect, useState } from 'react';

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

export function ProviderSetupDialog({
  provider,
  label,
  projectId,
  onClose,
}: {
  provider: string;
  label: string;
  projectId?: string | null;
  onClose: () => void;
}) {
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
            {status.auth === 'connected'
              ? 'Connected. You can return to your message.'
              : status.auth === 'configured'
                ? 'Credentials are configured. You can return to your message.'
                : status.auth === 'required'
                  ? 'Sign in to continue. Funny will open the login process in its terminal.'
                  : 'Open the terminal to sign in. This provider does not support automatic session verification.'}
          </p>
        )}
        {provider === 'pi' && status?.auth === 'required' && (
          <p className="text-sm">
            {status.loginCommand
              ? 'Connect Pi, then type /login in the terminal and choose your provider. After signing in, return to your message.'
              : 'Install Pi to sign in, then connect and type /login in the terminal to choose your provider.'}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => setRevision((value) => value + 1)}
          >
            Check again
          </Button>
          {status?.loginCommand &&
            projectId &&
            status.auth !== 'connected' &&
            status.auth !== 'configured' && (
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
          {status?.installable && status.state !== 'installed' && (
            <Button
              disabled={pending || status.state === 'installing'}
              onClick={() => void install()}
            >
              {pending || status.state === 'installing'
                ? 'Installing…'
                : status.state === 'failed'
                  ? 'Retry installation'
                  : 'Install on runner'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
