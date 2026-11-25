import { Sparkles, X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useThreadRecap, type ThreadRecapView } from '@/data/thread-recap/hooks';
import { buildPath } from '@/lib/url';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsFilterStore } from '@/stores/settings-filter-store';
import { useThreadOpenSnapshot } from '@/stores/thread-read-store';
import { useUIStore } from '@/stores/ui-store';

interface RecapThread {
  id: string;
  userId: string;
  createdAt: string;
  runtime?: string | null;
}

/**
 * A short recap of what the agent did while the owner was away (openspec
 * `thread-recap`), in the bottom dock right above the follow-up input. The recap is generated text, shown as plain
 * text: no markdown, no links. Any failure shows nothing, except a missing
 * utility model credential, which shows a hint once per session.
 */
export function ThreadRecapCard({ thread }: { thread: RecapThread }) {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const opened = useThreadOpenSnapshot(thread.id);
  const dismissedRecaps = useUIStore((s) => s.dismissedRecaps);
  const view = useThreadRecap(thread, currentUserId, opened, (key) => !!dismissedRecaps[key]);
  const openKey = opened ? `${thread.id}:${opened.openedAt}` : null;
  return <ThreadRecapCardView view={view} openKey={openKey} />;
}

function ThreadRecapCardView({ view, openKey }: { view: ThreadRecapView; openKey: string | null }) {
  const dismissRecap = useUIStore((s) => s.dismissRecap);
  if (view.state === 'hidden') return null;
  if (view.state === 'unavailable') {
    return openKey ? <UtilityModelHint recapKey={view.key} openKey={openKey} /> : null;
  }
  return (
    <RecapShell onDismiss={() => dismissRecap(view.key)} testId="thread-recap-card">
      {view.state === 'loading' ? (
        <div className="flex flex-col gap-1.5" data-testid="thread-recap-loading">
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : (
        <p className="text-sm whitespace-pre-wrap" data-testid="thread-recap-text">
          {view.recap}
        </p>
      )}
    </RecapShell>
  );
}

function RecapShell({
  onDismiss,
  testId,
  children,
}: {
  onDismiss: () => void;
  testId: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="px-3 pt-2 pb-2 sm:px-4">
      <div className="mx-auto w-full max-w-3xl min-w-0">
        <Card className="shadow-none" data-testid={testId}>
          <div className="flex items-start gap-3 px-3 py-2.5">
            <Sparkles className="icon-sm text-muted-foreground mt-0.5 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-muted-foreground mb-1 text-xs font-medium">
                {t('thread.recap.title')}
              </p>
              {children}
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              aria-label={t('thread.recap.dismiss')}
              onClick={onDismiss}
              data-testid="thread-recap-dismiss"
            >
              <X className="icon-xs" />
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

/** Shown for the first thread open of the session whose recap had no credential. */
function UtilityModelHint({ recapKey, openKey }: { recapKey: string; openKey: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hintOpenKey = useUIStore((s) => s.recapHintOpenKey);
  const claimRecapHint = useUIStore((s) => s.claimRecapHint);
  const dismissRecap = useUIStore((s) => s.dismissRecap);
  const setFocusId = useSettingsFilterStore((s) => s.setFocusId);

  useEffect(() => {
    claimRecapHint(openKey);
  }, [claimRecapHint, openKey]);

  if (hintOpenKey !== null && hintOpenKey !== openKey) return null;
  return (
    <RecapShell onDismiss={() => dismissRecap(recapKey)} testId="thread-recap-hint">
      <p className="text-muted-foreground text-sm">{t('thread.recap.unavailableHint')}</p>
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0"
        onClick={() => {
          setFocusId('models.utility-model');
          navigate(buildPath('/preferences/models'));
        }}
        data-testid="thread-recap-hint-settings"
      >
        {t('thread.recap.openUtilityModelSetting')}
      </Button>
    </RecapShell>
  );
}
