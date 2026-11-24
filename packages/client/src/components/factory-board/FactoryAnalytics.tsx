/**
 * The factory view's analytics layout, laid out like the analytics view
 * (`AnalyticsView`): the factory's health right now, over every listed run
 * (the filters do not change it), then how integration went over the runs the
 * filters keep. Computed from the runs the view already has.
 */
import { BarChart3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FACTORY_METRICS_WINDOW_DAYS, summarizeFactoryRuns } from '@/data/factory/metrics';
import type { FactoryQueueRun } from '@/lib/api/factory';

import { FactoryHealthStats } from './FactoryHealthHeader';
import { FactoryIntegrationStats } from './FactoryIntegrationStats';

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3" data-testid={`factory-analytics-${id}`}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export function FactoryAnalytics({
  runs,
  filtered,
  now,
}: {
  /** Every listed run: what the health figures cover. */
  runs: FactoryQueueRun[] | undefined;
  /** The runs the filters keep: what the integration figures cover. */
  filtered: FactoryQueueRun[] | undefined;
  now: number;
}) {
  const { t } = useTranslation();
  if (!runs) return <LoadingState testId="factory-analytics-loading" />;
  const integrated = summarizeFactoryRuns(filtered ?? [], { now }).runs > 0;
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title={t('factoryView.analytics.empty', 'No factory runs to measure')}
        testId="factory-analytics-empty"
      />
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-6" data-testid="factory-analytics">
        <Section id="health" title={t('factoryView.analytics.health', 'Right now')}>
          <FactoryHealthStats runs={runs} now={now} />
        </Section>
        <Section
          id="integration"
          title={t('factory.metrics.title', 'Integration, last {{days}} days', {
            days: FACTORY_METRICS_WINDOW_DAYS,
          })}
        >
          {integrated ? (
            <FactoryIntegrationStats runs={filtered ?? []} now={now} />
          ) : (
            <EmptyState
              fill={false}
              padding="md"
              title={t(
                'factoryView.analytics.noIntegration',
                'No run the filters keep started in this period',
              )}
              testId="factory-analytics-no-integration"
            />
          )}
        </Section>
      </div>
    </ScrollArea>
  );
}
