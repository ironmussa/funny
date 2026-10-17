import type { FileDiffSummary } from '@funny/shared';
import { FileCode, FilePlus, FileWarning, FileX } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import {
  buildFileSearch,
  buildPrSummary,
  expandedFileIcon,
} from '@/components/review-pane/review-pane-props';

const summary = (status: FileDiffSummary['status']): FileDiffSummary => ({
  path: 'a.ts',
  status,
  staged: false,
});

describe('expandedFileIcon', () => {
  it('falls back to FileCode without a summary', () => {
    expect(expandedFileIcon(undefined)).toBe(FileCode);
  });

  it('maps each git status to its icon', () => {
    expect(expandedFileIcon(summary('added'))).toBe(FilePlus);
    expect(expandedFileIcon(summary('modified'))).toBe(FileCode);
    expect(expandedFileIcon(summary('deleted'))).toBe(FileX);
    expect(expandedFileIcon(summary('renamed'))).toBe(FileCode);
    expect(expandedFileIcon(summary('conflicted'))).toBe(FileWarning);
    expect(expandedFileIcon(summary('unknown' as FileDiffSummary['status']))).toBe(FileCode);
  });
});

describe('buildPrSummary', () => {
  it('returns null without a PR', () => {
    expect(buildPrSummary(undefined, 'p1', true)).toBeNull();
    expect(buildPrSummary({}, 'p1', true)).toBeNull();
    expect(buildPrSummary({ prNumber: 0 }, 'p1', true)).toBeNull();
  });

  it('defaults url and state', () => {
    expect(buildPrSummary({ prNumber: 7 }, 'p1', false)).toEqual({
      projectId: 'p1',
      prNumber: 7,
      prUrl: '',
      prState: 'OPEN',
      visible: false,
    });
  });

  it('passes through url and state', () => {
    expect(
      buildPrSummary({ prNumber: 7, prUrl: 'https://x/7', prState: 'MERGED' }, '', true),
    ).toEqual({
      projectId: '',
      prNumber: 7,
      prUrl: 'https://x/7',
      prState: 'MERGED',
      visible: true,
    });
  });
});

describe('buildFileSearch', () => {
  const base = {
    setFileSearch: vi.fn(),
    caseSensitive: true,
    setCaseSensitive: vi.fn(),
    matchCount: 2,
    totalCount: 5,
    placeholder: 'Filter files…',
  };

  it('hides the result label and close button with an empty query', () => {
    const props = buildFileSearch({ ...base, fileSearch: '' });
    expect(props).toMatchObject({
      query: '',
      totalMatches: 2,
      resultLabel: '',
      caseSensitive: true,
      autoFocus: false,
      testIdPrefix: 'review-file-filter',
      placeholder: 'Filter files…',
    });
    expect(props.onClose).toBeUndefined();
  });

  it('shows matches/total and clears the query on close', () => {
    const setFileSearch = vi.fn();
    const props = buildFileSearch({ ...base, fileSearch: 'foo', setFileSearch });
    expect(props.resultLabel).toBe('2/5');
    props.onClose!();
    expect(setFileSearch).toHaveBeenCalledWith('');
    props.onQueryChange('bar');
    expect(setFileSearch).toHaveBeenCalledWith('bar');
  });
});
