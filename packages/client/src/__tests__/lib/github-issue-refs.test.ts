import { describe, expect, test } from 'bun:test';

import { githubRepoBaseUrl, linkIssueReferences } from '@/lib/github-issue-refs';

const REPO = 'https://github.com/o/r';

describe('githubRepoBaseUrl', () => {
  test('takes the repository of an issue URL', () => {
    expect(githubRepoBaseUrl('https://github.com/o/r/issues/7')).toBe(REPO);
  });
  test('answers null for a non-GitHub URL', () => {
    expect(githubRepoBaseUrl('https://example.com/o/r')).toBeNull();
    expect(githubRepoBaseUrl(undefined)).toBeNull();
  });
});

describe('linkIssueReferences', () => {
  test('links a bare reference', () => {
    expect(linkIssueReferences('the test from #555 expects', REPO)).toBe(
      `the test from [#555](${REPO}/issues/555) expects`,
    );
  });

  test('links references at the start and after punctuation', () => {
    expect(linkIssueReferences('#1, (#2)', REPO)).toBe(
      `[#1](${REPO}/issues/1), ([#2](${REPO}/issues/2))`,
    );
  });

  test('leaves code, links, URLs and headings alone', () => {
    const body = [
      'see `#5` and [#6](https://x.y) at https://github.com/o/r/issues/7#issuecomment-1',
      '```',
      '#8',
      '```',
      '# Heading',
      'color#9 a#b',
    ].join('\n');
    expect(linkIssueReferences(body, REPO)).toBe(body);
  });

  test('changes nothing without a repository', () => {
    expect(linkIssueReferences('#5', null)).toBe('#5');
  });
});
