import { Loader2, CheckCircle2, XCircle, ExternalLink, ArrowRight, Terminal } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

import { Button } from '@/components/ui/button';
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
          <Terminal className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Welcome to funny</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Orchestrate multiple Claude Code agents in parallel. Each agent works on its own git
          branch, so they never conflict.
        </p>
      </div>

      <div className="space-y-2 text-sm text-muted-foreground">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 font-mono text-xs text-primary">1.</span>
          <span>Create a project by pointing to any git repository</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="mt-0.5 font-mono text-xs text-primary">2.</span>
          <span>Spin up threads — each runs a Claude Code agent</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="mt-0.5 font-mono text-xs text-primary">3.</span>
          <span>Review changes, commit, and merge when ready</span>
        </div>
      </div>

      <Button className="w-full" onClick={onNext}>
        Get Started
        <ArrowRight className="ml-1 h-4 w-4" />
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
        error: 'Could not reach the server',
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
        <h2 className="text-lg font-semibold text-foreground">Claude Code CLI</h2>
        <p className="text-sm text-muted-foreground">
          funny needs the Claude Code CLI to run agents.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
        {checking ? (
          <div className="flex items-center justify-center gap-2 py-2">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Checking...</span>
          </div>
        ) : status?.available ? (
          <>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-status-success" />
              <span className="text-sm font-medium text-foreground">Claude CLI found</span>
            </div>
            {status.version && (
              <div className="font-mono text-xs text-muted-foreground">{status.version}</div>
            )}
            {status.path && (
              <div className="truncate font-mono text-xs text-muted-foreground">{status.path}</div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-status-error" />
              <span className="text-sm font-medium text-foreground">Claude CLI not found</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Install the Claude Code CLI to continue. Visit the official documentation for
              installation instructions.
            </p>
            <a
              href="https://docs.anthropic.com/en/docs/claude-code/overview"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              Installation Guide
              <ExternalLink className="h-3 w-3" />
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
        <Button className="flex-1" disabled={checking || !status?.available} onClick={onNext}>
          Continue
          <ArrowRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </>
  );
}

function DoneSlide({ onFinish }: { onFinish: () => void }) {
  return (
    <>
      <div className="space-y-3 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-status-success" />
        <h2 className="text-lg font-semibold text-foreground">You're all set!</h2>
        <p className="text-sm text-muted-foreground">
          Everything is configured. Add your first project to get started.
        </p>
      </div>

      <Button className="w-full" onClick={onFinish}>
        Enter funny
        <ArrowRight className="ml-1 h-4 w-4" />
      </Button>
    </>
  );
}

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);

  const handleFinish = () => {
    api.completeSetup();
    onComplete();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md space-y-6 rounded-lg border border-border bg-card p-8 shadow-lg">
        <StepIndicator current={step} total={3} />

        {step === 0 && <WelcomeSlide onNext={() => setStep(1)} />}
        {step === 1 && <ClaudeCheckSlide onNext={() => setStep(2)} />}
        {step === 2 && <DoneSlide onFinish={handleFinish} />}
      </div>
    </div>
  );
}
