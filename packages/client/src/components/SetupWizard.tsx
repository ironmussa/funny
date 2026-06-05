import { CheckCircle2, XCircle, ExternalLink, ArrowRight, Terminal } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type CliStatus = {
  available: boolean;
  path: string | null;
  error: string | null;
  version: string | null;
};

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            'h-1.5 rounded-full transition-all duration-300',
            i === current
              ? 'w-6 bg-primary'
              : i < current
                ? 'w-1.5 bg-primary/60'
                : 'w-1.5 bg-muted-foreground/25',
          )}
        />
      ))}
    </div>
  );
}

function WelcomeSlide({ onNext }: { onNext: () => void }) {
  return (
    <>
      <div className="space-y-3 text-center">
        <div className="flex items-center justify-center">
          <Terminal className="text-primary size-8" />
        </div>
        <h1 className="text-foreground text-2xl font-semibold">Welcome to funny</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Orchestrate multiple Claude Code agents in parallel. Each agent works on its own git
          branch, so they never conflict.
        </p>
      </div>

      <div className="text-muted-foreground space-y-2 text-sm">
        <div className="flex items-start gap-2">
          <span className="text-primary mt-0.5 font-mono text-xs">1.</span>
          <span>Create a project by pointing to any git repository</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-primary mt-0.5 font-mono text-xs">2.</span>
          <span>Spin up threads: each runs a Claude Code agent</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-primary mt-0.5 font-mono text-xs">3.</span>
          <span>Review changes, commit, and merge when ready</span>
        </div>
      </div>

      <Button className="w-full" onClick={onNext}>
        Get Started
        <ArrowRight className="icon-base ml-1" />
      </Button>
    </>
  );
}

function ClaudeCheckSlide({ onNext }: { onNext: () => void }) {
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [checking, setChecking] = useState(true);

  const checkCli = useCallback(async () => {
    setChecking(true);
    const result = await api.setupStatus();
    if (result.isOk()) {
      setStatus(result.value.claudeCli);
    } else {
      setStatus({
        available: false,
        path: null,
        error: 'server_unreachable',
        version: null,
      });
    }
    setChecking(false);
  }, []);

  useEffect(() => {
    checkCli();
  }, [checkCli]);

  return (
    <>
      <div className="space-y-1 text-center">
        <h2 className="text-foreground text-lg font-semibold">Claude Code CLI</h2>
        <p className="text-muted-foreground text-sm">
          funny needs the Claude Code CLI to run agents.
        </p>
      </div>

      <div className="border-border bg-muted/30 space-y-3 rounded-lg border p-4">
        {checking ? (
          <LoadingState
            fill={false}
            layout="inline"
            className="py-2"
            testId="setup-wizard-checking"
            label="Checking…"
          />
        ) : status?.available ? (
          <>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="icon-lg text-status-success" />
              <span className="text-foreground text-sm font-medium">Claude CLI found</span>
            </div>
            {status.version && (
              <div className="text-muted-foreground font-mono text-xs">{status.version}</div>
            )}
            {status.path && (
              <div className="text-muted-foreground truncate font-mono text-xs">{status.path}</div>
            )}
          </>
        ) : status?.error === 'server_unreachable' ? (
          <>
            <div className="flex items-center gap-2">
              <XCircle className="icon-lg text-status-error" />
              <span className="text-foreground text-sm font-medium">Server not reachable</span>
            </div>
            <p className="text-muted-foreground text-xs">
              Could not connect to the funny server. Make sure the server is running and try again.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <XCircle className="icon-lg text-status-error" />
              <span className="text-foreground text-sm font-medium">Claude CLI not found</span>
            </div>
            <p className="text-muted-foreground text-xs">
              Install the Claude Code CLI to continue. Visit the official documentation for
              installation instructions.
            </p>
            <a
              href="https://docs.anthropic.com/en/docs/claude-code/overview"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary inline-flex items-center gap-1.5 text-xs hover:underline"
            >
              Installation Guide
              <ExternalLink className="icon-xs" />
            </a>
          </>
        )}
      </div>

      <div className="flex gap-2">
        {!checking && !status?.available && (
          <Button variant="outline" className="flex-1" onClick={checkCli}>
            Check Again
          </Button>
        )}
        <Button
          className="flex-1"
          disabled={checking || (!status?.available && status?.error !== 'server_unreachable')}
          onClick={onNext}
        >
          Continue
          <ArrowRight className="icon-base ml-1" />
        </Button>
      </div>
    </>
  );
}

function DoneSlide({ onFinish }: { onFinish: () => void }) {
  return (
    <>
      <div className="space-y-3 text-center">
        <CheckCircle2 className="text-status-success mx-auto size-10" />
        <h2 className="text-foreground text-lg font-semibold">You're all set!</h2>
        <p className="text-muted-foreground text-sm">
          Everything is configured. Add your first project to get started.
        </p>
      </div>

      <Button className="w-full" onClick={onFinish}>
        Enter funny
        <ArrowRight className="icon-base ml-1" />
      </Button>
    </>
  );
}

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);

  const handleFinish = async () => {
    const res = await api.completeSetup();
    if (res.isErr()) {
      // Retry once before proceeding
      await api.completeSetup();
    }
    localStorage.setItem('funny:setupCompleted', 'true');
    onComplete();
  };

  return (
    <div className="bg-background flex min-h-screen items-center justify-center">
      <div className="border-border bg-card w-full max-w-md space-y-6 rounded-lg border p-8 shadow-lg">
        <StepIndicator current={step} total={3} />

        {step === 0 && <WelcomeSlide onNext={() => setStep(1)} />}
        {step === 1 && <ClaudeCheckSlide onNext={() => setStep(2)} />}
        {step === 2 && <DoneSlide onFinish={handleFinish} />}
      </div>
    </div>
  );
}
