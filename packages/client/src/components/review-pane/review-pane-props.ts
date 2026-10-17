import type { FileDiffSummary, GitStatusInfo } from '@funny/shared';
import { FileCode, FilePlus, FileWarning, FileX } from 'lucide-react';
import type { ComponentProps } from 'react';

import type { PRSummaryCard } from '@/components/PRSummaryCard';
import type { SearchBarProps } from '@/components/ui/search-bar';

/**
 * Pure prop builders for `ReviewPane`: they turn review state into the props
 * of its child components so the pane itself stays free of branching.
 */

const fileStatusIcons: Record<string, typeof FileCode> = {
  added: FilePlus,
  modified: FileCode,
  deleted: FileX,
  renamed: FileCode,
  conflicted: FileWarning,
};

/** Header icon for the expanded diff, keyed by the file's git status. */
export function expandedFileIcon(summary: FileDiffSummary | undefined): typeof FileCode {
  if (!summary) return FileCode;
  return fileStatusIcons[summary.status] || FileCode;
}

type PrGitStatus = Pick<GitStatusInfo, 'prNumber' | 'prUrl' | 'prState'>;

/** PR summary card props, or `null` when the branch has no PR. */
export function buildPrSummary(
  gitStatus: PrGitStatus | undefined,
  projectId: string,
  visible: boolean,
): ComponentProps<typeof PRSummaryCard> | null {
  if (!gitStatus?.prNumber) return null;
  return {
    projectId,
    prNumber: gitStatus.prNumber,
    prUrl: gitStatus.prUrl ?? '',
    prState: gitStatus.prState ?? 'OPEN',
    visible,
  };
}

/** Props of the Changes-tab file filter search bar. */
export function buildFileSearch({
  fileSearch,
  setFileSearch,
  caseSensitive,
  setCaseSensitive,
  matchCount,
  totalCount,
  placeholder,
}: {
  fileSearch: string;
  setFileSearch: (query: string) => void;
  caseSensitive: boolean;
  setCaseSensitive: (value: boolean) => void;
  matchCount: number;
  totalCount: number;
  placeholder: string;
}): SearchBarProps {
  return {
    query: fileSearch,
    onQueryChange: setFileSearch,
    placeholder,
    totalMatches: matchCount,
    resultLabel: fileSearch ? `${matchCount}/${totalCount}` : '',
    caseSensitive,
    onCaseSensitiveChange: setCaseSensitive,
    onClose: fileSearch ? () => setFileSearch('') : undefined,
    autoFocus: false,
    testIdPrefix: 'review-file-filter',
  };
}
