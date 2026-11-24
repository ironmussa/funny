import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import type { TreeRow } from '@/lib/file-tree';
import { cn } from '@/lib/utils';

import { INDENT_PX, type FileTreeRowCommon } from './row-props';

interface FileTreeSubmoduleStatusRowProps {
  row: Extract<TreeRow, { kind: 'submodule-status' }>;
  style?: CSSProperties;
  common: FileTreeRowCommon;
}

export function FileTreeSubmoduleStatusRow({
  row,
  style,
  common,
}: FileTreeSubmoduleStatusRowProps) {
  const { t } = useTranslation();
  const { fontSize, testIdPrefix } = common;
  const label =
    // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
    row.state === 'loading'
      ? t('review.submoduleLoading', { defaultValue: 'Loading submodule files…' })
      : row.state === 'error'
        ? (row.message ?? t('review.submoduleError', { defaultValue: 'Failed to load submodule' }))
        : t('review.submoduleEmpty', { defaultValue: 'No changes inside submodule' });
  return (
    <div
      className={cn(
        'flex h-[24px] select-none items-center gap-1.5 overflow-hidden pr-1 italic',
        fontSize,
        'text-muted-foreground/80',
      )}
      style={{
        ...style,
        paddingLeft: `${8 + row.depth * INDENT_PX}px`,
      }}
      data-testid={`${testIdPrefix}-submodule-status-${row.submodulePath}`}
    >
      <span className="truncate">{label}</span>
    </div>
  );
}
