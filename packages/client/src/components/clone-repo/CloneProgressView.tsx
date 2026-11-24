import { useTranslation } from 'react-i18next';

import { LoadingState } from '@/components/ui/loading-state';
import { cn } from '@/lib/utils';

interface CloneProgressViewProps {
  repoFullName: string | undefined;
  clonePhase: string;
  clonePercent: number | undefined;
  phaseChanged: boolean;
}

/** The running clone: its current phase and a progress bar. */
export function CloneProgressView({
  repoFullName,
  clonePhase,
  clonePercent,
  phaseChanged,
}: CloneProgressViewProps) {
  const { t } = useTranslation();
  // Extract phase name and title-case it: "receiving objects" → "Receiving Objects"
  const phaseName = clonePhase
    ? clonePhase
        .replace(/:.*$/, '')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : '';

  return (
    <div className="flex flex-col items-center gap-4 py-12">
      <LoadingState fill={false} label={t('github.clone.cloning', { repo: repoFullName })} />

      {/* Progress bar with phase label */}
      <div className="w-full max-w-xs">
        {phaseName && <p className="text-muted-foreground mb-1 text-xs font-medium">{phaseName}</p>}
        {clonePercent !== undefined && (
          <>
            <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
              <div
                className={cn(
                  'h-full rounded-full bg-primary',
                  phaseChanged ? '' : 'transition-all duration-300',
                )}
                style={{ width: `${clonePercent}%` }}
              />
            </div>
            <p className="text-muted-foreground mt-1 text-right text-xs">{clonePercent}%</p>
          </>
        )}
      </div>
    </div>
  );
}
