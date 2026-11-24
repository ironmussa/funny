import { SiGithub } from '@icons-pack/react-simple-icons';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

/** Shown when the GitHub connection check itself failed (network error, server down, etc.). */
export function ConnectionErrorView({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <div className="bg-destructive/10 flex size-12 items-center justify-center rounded-full">
        <SiGithub className="icon-xl text-destructive" />
      </div>
      <div className="space-y-1 text-center">
        <h3 className="font-medium">
          {t('github.connectionError', { defaultValue: 'Connection Error' })}
        </h3>
        <p className="text-muted-foreground max-w-xs text-sm">
          {t('github.connectionErrorDesc', {
            defaultValue:
              'Could not check GitHub connection status. The server may be unavailable.',
          })}
        </p>
      </div>
      <Button onClick={onRetry} data-testid="clone-repo-retry">
        {t('common.retry', { defaultValue: 'Retry' })}
      </Button>
    </div>
  );
}
