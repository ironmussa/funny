/**
 * RunnerOnboardingBanner — surfaced when a logged-in user (in team mode) has no
 * runner connected. This is the discoverability fix: the install command always
 * lived in Settings → Runners, but a freshly-added collaborator never knew to
 * go there. The banner gives them the exact command up-front and disappears on
 * its own once a runner comes online (useRunnerStatus polls).
 */

import { Server, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ConnectRunnerCard } from '@/components/ConnectRunnerCard';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useRunnerStatus } from '@/hooks/use-runner-status';
import { api } from '@/lib/api';

export function RunnerOnboardingBanner() {
  const { hasRunner } = useRunnerStatus();
  const [mode, setMode] = useState<'team' | 'standalone' | null>(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.bootstrap().then((res) => {
      if (!cancelled) setMode(res.isOk() ? res.value.mode : 'team');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only relevant in team mode (standalone bundles its own runtime). Wait until
  // we positively know the user has zero runners before nagging.
  if (mode !== 'team' || hasRunner !== false || dismissed) return null;

  return (
    <>
      <div
        className="border-primary/30 bg-primary/10 flex items-center gap-3 border-b px-4 py-2"
        data-testid="runner-onboarding-banner"
      >
        <Server className="text-primary icon-base shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">No runner connected</p>
          <p className="text-muted-foreground text-xs">
            Agents run on your own machine. Connect a runner to start working.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="runner-onboarding-connect"
          className="shrink-0"
        >
          Connect a runner
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-7 shrink-0"
          onClick={() => setDismissed(true)}
          data-testid="runner-onboarding-dismiss"
          aria-label="Dismiss"
        >
          <X className="icon-sm" />
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connect a runner</DialogTitle>
            <DialogDescription>
              A runner is a process on your own machine that executes your agents (it has access to
              your files and git credentials). Run this on any machine — it connects under your
              account and shows up here when online.
            </DialogDescription>
          </DialogHeader>
          <ConnectRunnerCard />
        </DialogContent>
      </Dialog>
    </>
  );
}
