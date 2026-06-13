/**
 * ConnectRunnerCard — the canonical "start a runner and link it" UI.
 *
 * With device-link enrollment the runner needs no token or shared secret up
 * front: the operator runs one zero-config command, and the runner prints a
 * short code to approve in Settings ▸ Runners (see LinkRunnerForm). This card
 * shows that command and the steps; it deliberately does NOT show a
 * `--token`-only command, which the CLI would reject for a missing `--secret`.
 *
 * Reused in the onboarding banner shown to users who have not connected a
 * runner yet.
 */

import { Check, Copy, ExternalLink, Server } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Published Railway template code for the funny runner (the "funny-runner"
 * template, whose service config lives in railway.runner.json). Empty until the
 * maintainer publishes it in Railway's template composer and pastes the code
 * here. When set, a "Deploy on Railway" button appears that prefills
 * TEAM_SERVER_URL with this server's origin — a true one-click runner with no
 * env vars to fill in (device-link handles auth). Gated so we never render a
 * dead link.
 */
const RAILWAY_RUNNER_TEMPLATE_CODE = '';

interface Props {
  /** Render the numbered "how to" steps above the command. Default: true. */
  showSteps?: boolean;
  /**
   * Deprecated — kept for backward compatibility with existing call sites.
   * Token rotation no longer applies to the device-link flow.
   */
  showRotate?: boolean;
  className?: string;
}

export function ConnectRunnerCard({ showSteps = true, className }: Props) {
  const [copied, setCopied] = useState(false);

  const serverUrl = window.location.origin;
  const installCommand = `bunx funny --team ${serverUrl}`;
  const railwayDeployUrl = RAILWAY_RUNNER_TEMPLATE_CODE
    ? `https://railway.com/new/template/${RAILWAY_RUNNER_TEMPLATE_CODE}?TEAM_SERVER_URL=${encodeURIComponent(serverUrl)}`
    : null;

  const handleCopy = () => {
    navigator.clipboard.writeText(installCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success('Command copied');
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
            <span>Run the command below on that machine. It will print a short code.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5 font-mono">3.</span>
            <span>
              Enter that code under “Link a runner” below to approve it. It appears as “online”
              within a few seconds.
            </span>
          </li>
        </ol>
      )}

      <div className="flex items-center gap-2">
        <code
          className="bg-muted text-foreground flex-1 truncate rounded px-3 py-2 font-mono text-xs"
          data-testid="connect-runner-command"
        >
          {installCommand}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopy}
          className="shrink-0"
          data-testid="connect-runner-copy"
        >
          {copied ? <Check className="icon-sm" /> : <Copy className="icon-sm" />}
        </Button>
      </div>

      {railwayDeployUrl && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">Or deploy a cloud runner:</span>
          <Button size="sm" variant="outline" asChild data-testid="connect-runner-railway">
            <a href={railwayDeployUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="icon-sm mr-1" />
              Deploy on Railway
            </a>
          </Button>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        <Server className="icon-xs mr-1 inline" />
        No token or shared secret needed — you approve the runner from this page.
      </p>
    </div>
  );
}
