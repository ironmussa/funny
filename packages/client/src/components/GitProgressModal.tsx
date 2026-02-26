import { Check, Circle, Loader2, X, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface GitProgressStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  /** Optional URL to display on completion (e.g., PR link) */
  url?: string;
}

interface GitProgressModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  steps: GitProgressStep[];
  title: string;
}

export function GitProgressModal({ open, onOpenChange, steps, title }: GitProgressModalProps) {
  const { t } = useTranslation();
  const isFinished = steps.length > 0 && steps.every((s) => s.status === 'completed' || s.status === 'failed');
  const hasFailed = steps.some((s) => s.status === 'failed');

  return (
    <Dialog open={open} onOpenChange={isFinished ? onOpenChange : undefined}>
      <DialogContent className="max-w-sm" onPointerDownOutside={(e) => { if (!isFinished) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('review.progress.description', 'Git operation progress')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {steps.map((step) => (
            <div key={step.id} className="flex items-start gap-2.5">
              <div className="mt-0.5 flex-shrink-0">
                {step.status === 'completed' && (
                  <Check className="h-4 w-4 text-emerald-500" />
                )}
                {step.status === 'running' && (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                )}
                {step.status === 'failed' && (
                  <X className="h-4 w-4 text-destructive" />
                )}
                {step.status === 'pending' && (
                  <Circle className="h-4 w-4 text-muted-foreground/40" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <span
                  className={cn(
                    'text-xs',
                    step.status === 'completed' && 'text-muted-foreground',
                    step.status === 'running' && 'text-foreground font-medium',
                    step.status === 'failed' && 'text-destructive font-medium',
                    step.status === 'pending' && 'text-muted-foreground/60',
                  )}
                >
                  {step.label}
                </span>
                {step.error && (
                  <p className="mt-0.5 text-[11px] text-destructive/80">{step.error}</p>
                )}
                {step.url && step.status === 'completed' && (
                  <a
                    href={step.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 flex items-center gap-1 text-[11px] text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {step.url}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
        {isFinished && (
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant={hasFailed ? 'outline' : 'default'} onClick={() => onOpenChange(false)}>
              {hasFailed ? t('common.cancel', 'Close') : t('review.progress.done', 'Done')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
