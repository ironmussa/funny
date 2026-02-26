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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background">
      <div className="flex max-w-md flex-col items-center gap-6 px-6 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
          <WifiOff className="h-8 w-8 text-destructive" />
        </div>

        <div className="space-y-2">
          <h2 className="text-xl font-semibold">{t('circuitBreaker.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('circuitBreaker.description')}</p>
        </div>

        {isHalfOpen ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('circuitBreaker.attemptingReconnect')}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('circuitBreaker.willRetryAutomatically')}
          </p>
        )}

        {!isHalfOpen && (
          <Button onClick={retryNow} size="lg">
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('circuitBreaker.retryNow')}
          </Button>
        )}
      </div>
    </div>
  );
}
