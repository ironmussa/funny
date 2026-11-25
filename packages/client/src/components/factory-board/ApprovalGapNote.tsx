/**
 * What changed since the commit a member approved, for a run the factory holds
 * again on another commit (openspec factory-merge-fewer-bounces, D2). The
 * member already read the approved commit: this is what is left to read.
 *
 * Everything here is the factory's own comparison, stored with the hold. No
 * agent wrote any of it.
 */
import { approvalGapFor, type FactoryMergeApproval } from '@funny/shared/contracts/factory';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { LabelBadge } from '@/components/ui/label-badge';

const short = (sha: string) => sha.slice(0, 7);

/** GitHub's view of the commits between two commits of the pull request's repository. */
function compareUrl(prUrl: string | null, from: string, to: string): string | null {
  const repo = prUrl?.match(/^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/)?.[1];
  return repo ? `${repo}/compare/${from}...${to}` : null;
}

export function ApprovalGapNote({
  approval,
  heldSha,
  prUrl,
  testId,
}: {
  approval: FactoryMergeApproval | null | undefined;
  /** The commit the run is held on. */
  heldSha: string | null | undefined;
  prUrl: string | null;
  testId: string;
}) {
  const { t } = useTranslation();
  const gap = approvalGapFor(approval, heldSha);
  if (!gap) return null;
  const fresh = new Set(gap.newFiles);
  const url = compareUrl(prUrl, gap.approvedSha, gap.to);
  return (
    <div className="bg-muted/40 space-y-1 rounded-md border px-2 py-1.5" data-testid={testId}>
      <p className="text-foreground font-medium">
        {t('factory.approvalGap.title', 'You approved')}{' '}
        <code className="bg-muted rounded px-1 py-px font-mono">{short(gap.approvedSha)}</code>
        {'. '}
        {gap.lines === null
          ? t(
              'factory.approvalGap.unknown',
              'What changed since then could not be computed: read the whole change.',
            )
          : t('factory.approvalGap.lines', 'Since then, {{count}} lines of the change differ:', {
              count: gap.lines,
            })}
      </p>
      {gap.files.length > 0 && (
        <ul className="space-y-0.5" data-testid={`${testId}-files`}>
          {gap.files.map((file) => (
            <li key={file} className="flex flex-wrap items-center gap-1.5">
              <code className="text-foreground font-mono break-all">{file}</code>
              {fresh.has(file) && (
                <LabelBadge tone="warning">
                  {t('factory.approvalGap.newFile', 'not in the approved change')}
                </LabelBadge>
              )}
            </li>
          ))}
          {gap.moreFiles > 0 && (
            <li className="text-muted-foreground">
              {t('factory.approvalGap.moreFiles', 'and {{count}} more files', {
                count: gap.moreFiles,
              })}
            </li>
          )}
        </ul>
      )}
      {gap.newRiskKeys.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5" data-testid={`${testId}-risks`}>
          <span className="text-muted-foreground">
            {t('factory.approvalGap.newRisks', 'New risk reasons:')}
          </span>
          {gap.newRiskKeys.map((key) => (
            <code key={key} className="bg-muted rounded px-1 py-px font-mono">
              {key}
            </code>
          ))}
        </p>
      )}
      <p className="text-muted-foreground break-words">
        {t('factory.approvalGap.why', 'The approval did not follow because {{reason}}.', {
          reason: gap.reason,
        })}
      </p>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-foreground inline-flex items-center gap-1 underline underline-offset-2"
          data-testid={`${testId}-compare`}
        >
          {t('factory.approvalGap.compare', 'Commits since the approval')}
          <ExternalLink className="icon-xs" />
        </a>
      )}
    </div>
  );
}
