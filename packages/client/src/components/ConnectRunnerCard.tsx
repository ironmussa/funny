/**
 * ConnectRunnerCard — the canonical "run this command to connect a runner" UI.
 *
 * Extracted from RunnersSettings so the exact same install command + copy
 * affordance can be reused in the onboarding banner shown to users (especially
 * non-admin collaborators) who have not connected a runner yet. The token is
 * per-user, so this works for everyone — no admin involvement needed.
 */

import { Check, Copy, RefreshCw, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { cn } from '@/lib/utils';

const log = createClientLogger('runner-onboarding');

interface Props {
  /** Render the numbered "how to" steps above the command. Default: true. */
  showSteps?: boolean;
  /** Allow rotating the invite token. Default: true. */
  showRotate?: boolean;
  className?: string;
}

export function ConnectRunnerCard({ showSteps = true, showRotate = true, className }: Props) {
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [loadingToken, setLoadingToken] = useState(true);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);

  const serverUrl = window.location.origin;
  const installCommand = inviteToken ? `bunx funny --team ${serverUrl} --token ${inviteToken}` : '';

  const loadToken = async () => {
    setLoadingToken(true);
    const result = await api.getRunnerInviteToken();
    setLoadingToken(false);
    if (result.isOk()) setInviteToken(result.value.token);
    else log.warn('Failed to load runner invite token');
  };

  useEffect(() => {
    loadToken();
  }, []);

  const handleCopy = () => {
    if (!installCommand) return;
    navigator.clipboard.writeText(installCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success('Command copied');
  };

  const handleRotate = async () => {
    if (
      !confirm(
        'Rotate the invite token? Existing connected runners are unaffected, but the old token cannot be used to register new runners.',
      )
    )
      return;
    setRotating(true);
    const result = await api.rotateRunnerInviteToken();
    setRotating(false);
    if (result.isOk()) {
      setInviteToken(result.value.token);
      toast.success('Token rotated');
    } else {
      toast.error('Failed to rotate token');
    }
  };

  return (
    <div className={cn('space-y-3', className)} data-testid="connect-runner-card">
      {showSteps && (
        <ol className="text-muted-foreground space-y-1.5 text-xs">
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5 font-mono">1.</span>
            <span>
              Install Bun on the machine that will run your agents:{' '}
              <code className="bg-muted rounded px-1 py-0.5">
                curl -fsSL https://bun.sh/install | bash
              </code>
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5 font-mono">2.</span>
            <span>Run the command below on that machine. It connects under your account.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5 font-mono">3.</span>
            <span>Keep it running — it appears as “online” here within a few seconds.</span>
          </li>
        </ol>
      )}

      <div className="flex items-center gap-2">
        <code
          className="bg-muted text-foreground flex-1 truncate rounded px-3 py-2 font-mono text-xs"
          data-testid="connect-runner-command"
        >
          {loadingToken ? 'Loading…' : installCommand}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopy}
          disabled={loadingToken || !inviteToken}
          className="h-8 shrink-0"
          data-testid="connect-runner-copy"
        >
          {copied ? <Check className="icon-sm" /> : <Copy className="icon-sm" />}
        </Button>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          <Server className="icon-xs mr-1 inline" />
          The token is specific to your account. Anyone with it can register a runner under your
          name.
        </p>
        {showRotate && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleRotate}
            disabled={rotating || loadingToken}
            className="text-muted-foreground hover:text-foreground h-6 text-xs"
            data-testid="connect-runner-rotate"
          >
            <RefreshCw className={cn('mr-1 icon-xs', rotating && 'animate-spin')} />
            Rotate token
          </Button>
        )}
      </div>
    </div>
  );
}
