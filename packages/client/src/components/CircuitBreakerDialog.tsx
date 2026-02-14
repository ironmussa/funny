import { useTranslation } from 'react-i18next';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { WifiOff, RefreshCw, Loader2 } from 'lucide-react';

export function CircuitBreakerDialog() {
  const { t } = useTranslation();
  const dialogVisible = useCircuitBreakerStore((s) => s.dialogVisible);
  const state = useCircuitBreakerStore((s) => s.state);
  const retryNow = useCircuitBreakerStore((s) => s.retryNow);
  const dismissDialog = useCircuitBreakerStore((s) => s.dismissDialog);

  const isHalfOpen = state === 'half-open';

  return (
    <Dialog open={dialogVisible} onOpenChange={(open) => { if (!open) dismissDialog(); }}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <WifiOff className="h-5 w-5 text-destructive" />
            </div>
            <div>
              <DialogTitle>{t('circuitBreaker.title')}</DialogTitle>
              <DialogDescription className="mt-1">
                {t('circuitBreaker.description')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {isHalfOpen && (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('circuitBreaker.attemptingReconnect')}
          </p>
        )}

        {!isHalfOpen && (
          <p className="text-sm text-muted-foreground">
            {t('circuitBreaker.willRetryAutomatically')}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={dismissDialog} disabled={isHalfOpen}>
            {t('circuitBreaker.dismiss')}
          </Button>
          <Button onClick={retryNow} disabled={isHalfOpen}>
            {isHalfOpen ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('circuitBreaker.reconnecting')}
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('circuitBreaker.retryNow')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
