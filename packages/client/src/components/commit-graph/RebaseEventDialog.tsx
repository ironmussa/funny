import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { GitRebaseReflogEventDTO } from '@/lib/api/git';

export function RebaseEventDialog({
  event,
  onClose,
}: {
  event: GitRebaseReflogEventDTO | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!event} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        flush
        className="max-h-[80vh] max-w-2xl overflow-hidden"
        data-testid="rebase-event-dialog"
      >
        {event &&
          (() => {
            const commitPairs = event.commitPairs ?? [];
            const replayedCount = commitPairs.length || event.commitHashes.length;
            return (
              <div className="flex max-h-[80vh] min-h-0 flex-col">
                <div className="border-sidebar-border border-b px-4 py-3">
                  <DialogTitle size="sm" leading="tight">
                    {t('graph.rebaseDetailsTitle', 'Rebase details')}
                  </DialogTitle>
                  <DialogDescription size="xs" className="mt-1">
                    {event.completed
                      ? t('graph.rebaseDetailsDescription', {
                          count: replayedCount,
                          defaultValue: `${replayedCount} commits replayed from local reflog`,
                        })
                      : t(
                          'graph.rebaseDetailsIncomplete',
                          'Partial rebase details from local reflog',
                        )}
                  </DialogDescription>
                </div>

                <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-xs">
                  <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2">
                    <dt className="text-muted-foreground">{t('graph.rebaseBranch', 'Branch')}</dt>
                    <dd className="font-mono">{event.branch ?? '-'}</dd>
                    <dt className="text-muted-foreground">{t('graph.rebaseOnto', 'Onto')}</dt>
                    <dd className="font-mono">{event.onto ?? '-'}</dd>
                    <dt className="text-muted-foreground">{t('graph.rebaseStarted', 'Started')}</dt>
                    <dd className="font-mono">{event.startedAt ?? '-'}</dd>
                    <dt className="text-muted-foreground">
                      {t('graph.rebaseFinished', 'Finished')}
                    </dt>
                    <dd className="font-mono">{event.finishedAt ?? '-'}</dd>
                    <dt className="text-muted-foreground">{t('graph.rebaseBefore', 'Before')}</dt>
                    <dd className="font-mono">{event.startShortHash ?? '-'}</dd>
                    <dt className="text-muted-foreground">{t('graph.rebaseAfter', 'After')}</dt>
                    <dd className="font-mono">{event.finishShortHash ?? '-'}</dd>
                  </dl>

                  {commitPairs.length > 0 && (
                    <div className="border-sidebar-border mt-4 border-t pt-3">
                      <div className="text-muted-foreground text-2xs mb-2 font-medium uppercase">
                        {t('graph.rebaseCommitPairs', 'Rewritten commits')}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {commitPairs.map((pair) => (
                          <div
                            key={`${pair.originalHash}:${pair.rebasedHash}`}
                            className="bg-muted/40 grid grid-cols-[80px_16px_80px_minmax(0,1fr)] items-center gap-2 rounded px-2 py-1.5"
                          >
                            <span className="font-mono">{pair.originalShortHash}</span>
                            <span className="text-muted-foreground">→</span>
                            <span className="font-mono">{pair.rebasedShortHash}</span>
                            <span className="truncate">{pair.subject}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="border-sidebar-border mt-4 border-t pt-3">
                    <div className="text-muted-foreground text-2xs mb-2 font-medium uppercase">
                      {t('graph.rebaseSteps', 'Reflog steps')}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {event.steps.map((step) => (
                        <div
                          key={`${step.selector}:${step.action}:${step.hash}`}
                          className="bg-muted/40 grid grid-cols-[72px_88px_minmax(0,1fr)] gap-2 rounded px-2 py-1.5"
                        >
                          <span className="font-mono">{step.shortHash}</span>
                          <span className="text-muted-foreground">{step.action}</span>
                          <span className="truncate">{step.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
      </DialogContent>
    </Dialog>
  );
}
