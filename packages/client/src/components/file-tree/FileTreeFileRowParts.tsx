import type { FileDiffSummary } from '@funny/shared';
import { Check, ChevronRight, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FileName } from '@/components/ui/file-name';
import { FileExtensionIcon } from '@/lib/file-icons';
import { cn } from '@/lib/utils';

import { DiffStats } from '../DiffStats';
import { SubmoduleBadge } from '../SubmoduleBadge';
import type { FileTreeRowCommon } from './row-props';

function statusColor(status: string): string {
  switch (status) {
    case 'added':
      return 'hsl(142 40% 45%)';
    case 'modified':
      return 'hsl(30 90% 55%)';
    case 'deleted':
      return 'hsl(0 45% 55%)';
    default:
      return 'hsl(200 80% 60%)';
  }
}

function statusLetter(status: string): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    default:
      return 'R';
  }
}

interface FileCheckboxProps {
  path: string;
  checked: boolean;
  testIdPrefix: string;
  onToggle: (path: string) => void;
}

/** Selection checkbox at the start of a FileTree file row. */
export function FileCheckbox({ path, checked, testIdPrefix, onToggle }: FileCheckboxProps) {
  const { t } = useTranslation();
  return (
    <button
      role="checkbox"
      aria-checked={checked}
      aria-label={t('review.selectFile', {
        file: path,
        defaultValue: `Select ${path}`,
      })}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(path);
      }}
      className={cn(
        'flex items-center justify-center size-3.5 rounded border transition-colors shrink-0',
        checked
          ? 'bg-primary border-primary text-primary-foreground'
          : 'border-muted-foreground/40',
      )}
      data-testid={`${testIdPrefix}-check-${path}`}
    >
      {checked && <Check className="icon-2xs" />}
    </button>
  );
}

interface SubmoduleToggleProps {
  path: string;
  expanded: boolean;
  testIdPrefix: string;
  onToggle?: (submodulePath: string) => void;
}

/** Chevron that expands a submodule's inner file list. */
export function SubmoduleToggle({ path, expanded, testIdPrefix, onToggle }: SubmoduleToggleProps) {
  const { t } = useTranslation();
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.(path);
      }}
      aria-label={
        expanded
          ? t('review.collapseSubmodule', { defaultValue: 'Collapse submodule' })
          : t('review.expandSubmodule', { defaultValue: 'Expand submodule' })
      }
      className="text-muted-foreground hover:text-foreground flex size-4 shrink-0 items-center justify-center rounded"
      data-testid={`${testIdPrefix}-submodule-toggle-${path}`}
    >
      <ChevronRight className={cn('icon-sm transition-transform', expanded && 'rotate-90')} />
    </button>
  );
}

function effectiveLineCounts(f: FileDiffSummary) {
  const nested = f.nestedDirty;
  if (f.kind === 'submodule' && nested) {
    return { added: nested.linesAdded, deleted: nested.linesDeleted };
  }
  return { added: f.additions ?? 0, deleted: f.deletions ?? 0 };
}

type FileRowLabelProps = Pick<
  FileTreeRowCommon,
  'fontSize' | 'testIdPrefix' | 'searchQuery' | 'hideDiffStats' | 'hideStatus' | 'diffStatsSize'
> & {
  file: FileDiffSummary;
  canExpandSubmodule: boolean;
};

/** Icon, name, submodule badge, diff stats and status letter of a file row. */
export function FileRowLabel({
  file: f,
  canExpandSubmodule,
  fontSize,
  testIdPrefix,
  searchQuery,
  hideDiffStats,
  hideStatus,
  diffStatsSize,
}: FileRowLabelProps) {
  const fileName = f.path.split('/').pop() || f.path;
  const isSubmodule = f.kind === 'submodule';
  const counts = effectiveLineCounts(f);
  return (
    <>
      {isSubmodule ? (
        <GitBranch
          className="text-status-violet size-4 shrink-0"
          data-testid={`${testIdPrefix}-submodule-icon-${f.path}`}
        />
      ) : (
        <FileExtensionIcon filePath={f.path} className="text-muted-foreground/80 size-4 shrink-0" />
      )}
      <FileName
        name={fileName}
        query={searchQuery}
        preserveExtension={!isSubmodule}
        className={cn(
          'font-mono-explorer',
          // oxlint-disable-next-line shadcn/require-static-classes -- fontSize is a Tailwind class prop
          fontSize,
        )}
      />
      {isSubmodule && (
        <SubmoduleBadge
          nested={f.nestedDirty}
          testId={`${testIdPrefix}-submodule-badge-${f.path}`}
          showExpandHint={canExpandSubmodule}
        />
      )}
      {!hideDiffStats && (
        <DiffStats linesAdded={counts.added} linesDeleted={counts.deleted} size={diffStatsSize} />
      )}
      {!hideStatus && (
        <span
          className={cn('shrink-0 font-medium', fontSize)}
          style={{ color: statusColor(f.status) }}
        >
          {statusLetter(f.status)}
        </span>
      )}
    </>
  );
}
