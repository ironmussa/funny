import { WifiOff, RefreshCw, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';

export function CircuitBreakerDialog() {
  const { t } = useTranslation();
  const state = useCircuitBreakerStore((s) => s.state);
  const retryNow = useCircuitBreakerStore((s) => s.retryNow);

  // Only render when circuit is open or half-open
  if (state === 'closed') return null;

  const isHalfOpen = state === 'half-open';

  return (
    <div className="bg-background fixed inset-0 z-100 flex items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-6 px-6 text-center">
        <div className="bg-destructive/10 flex size-16 items-center justify-center rounded-full">
          <WifiOff className="text-destructive size-8" />
        </div>

        <div className="space-y-2">
          <h2 className="text-xl font-semibold">{t('circuitBreaker.title')}</h2>
          <p className="text-muted-foreground text-sm">{t('circuitBreaker.description')}</p>
        </div>

        {isHalfOpen ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="icon-base animate-spin" />
            {t('circuitBreaker.attemptingReconnect')}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            {t('circuitBreaker.willRetryAutomatically')}
          </p>
        )}

        {!isHalfOpen && (
          <Button onClick={retryNow} size="lg">
            <RefreshCw className="icon-base mr-2" />
            {t('circuitBreaker.retryNow')}
          </Button>
        )}
      </div>
    </div>
  );
}
