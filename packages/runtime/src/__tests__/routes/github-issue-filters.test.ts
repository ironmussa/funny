/**
 * The Issues panel's filters become qualifiers of GitHub's advanced issue
 * search (`issue-filters.ts`). These tests pin the qualifiers and that a
 * value cannot add qualifiers of its own.
 */
import { describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import { mapIssueFilterOptions } from '../../routes/github/issue-filter-options.js';
import {
  EMPTY_ISSUE_FILTERS,
  type IssueFilters,
  issueFilterTerms,
  issueRestSort,
  qualifierValue,
  readIssueFilters,
} from '../../routes/github/issue-filters.js';
import { issueSearchQuery } from '../../routes/github/issues-graphql.js';

const filters = (f: Partial<IssueFilters>): IssueFilters => ({ ...EMPTY_ISSUE_FILTERS, ...f });

async function read(qs: string): Promise<IssueFilters> {
  const app = new Hono();
  let out: IssueFilters = EMPTY_ISSUE_FILTERS;
  app.get('/', (c) => {
    out = readIssueFilters(c);
    return c.text('ok');
  });
  await app.request(`/?${qs}`);
  return out;
}

describe('qualifierValue', () => {
  test('quotes values the search syntax would split', () => {
    expect(qualifierValue('bug')).toBe('bug');
    expect(qualifierValue('ENV · PROD')).toBe('"ENV · PROD"');
    expect(qualifierValue('a,b')).toBe('"a,b"');
  });

  test('drops quotes, so a value cannot close itself and add qualifiers', () => {
    expect(qualifierValue('x" repo:other/repo "')).toBe('"x repo:other/repo"');
  });
});

describe('issueFilterTerms', () => {
  test('labels must all match; other filters match any selected value', () => {
    expect(
      issueFilterTerms(
        filters({
          labels: ['bug', 'ENV · PROD'],
          authors: ['octo', 'hubot'],
          assignees: ['octo'],
          milestones: ['v1 launch'],
          types: ['Bug', 'Task'],
          projects: ['acme/3'],
          sort: 'most-commented',
        }),
      ),
    ).toEqual([
      'label:bug',
      'label:"ENV · PROD"',
      '(author:octo OR author:hubot)',
      'assignee:octo',
      'milestone:"v1 launch"',
      '(type:Bug OR type:Task)',
      'project:acme/3',
      'sort:comments-desc',
    ]);
  });

  test('a value that is empty once cleaned adds no qualifier', () => {
    expect(issueFilterTerms(filters({ labels: ['""'], authors: ['"'] }))).toEqual([
      'sort:created-desc',
    ]);
  });
});

describe('issueSearchQuery with filters', () => {
  test('appends the filters after repository, type and state', () => {
    expect(
      issueSearchQuery('acme', 'widget', 'open', filters({ labels: ['bug'], sort: 'oldest' })),
    ).toBe('repo:acme/widget is:issue state:open label:bug sort:created-asc');
  });
});

describe('issueRestSort', () => {
  test('splits the sort into REST search parameters', () => {
    expect(issueRestSort('least-recently-updated')).toEqual({ sort: 'updated', order: 'asc' });
  });
});

describe('readIssueFilters', () => {
  test('reads comma-separated lists, de-duplicated', async () => {
    const f = await read('labels=bug,%20bug,frontend&authors=octo&sort=oldest');
    expect(f.labels).toEqual(['bug', 'frontend']);
    expect(f.authors).toEqual(['octo']);
    expect(f.sort).toBe('oldest');
  });

  test('an unknown sort falls back to newest; a malformed project is dropped', async () => {
    const f = await read('sort=stars&projects=acme/3,acme/x,a%20b/1');
    expect(f.sort).toBe('newest');
    expect(f.projects).toEqual(['acme/3']);
  });
});

describe('mapIssueFilterOptions', () => {
  test('maps the GraphQL responses; disabled types and closed projects are left out', () => {
    const options = mapIssueFilterOptions(
      {
        repository: {
          labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
          assignableUsers: { nodes: [{ login: 'octo', avatarUrl: 'https://a/octo' }] },
          milestones: { nodes: [{ title: 'v1' }] },
          issueTypes: {
            nodes: [
              { name: 'Bug', color: 'RED', isEnabled: true },
              { name: 'Old', color: 'GRAY', isEnabled: false },
            ],
          },
        },
      },
      {
        repository: {
          projectsV2: {
            nodes: [
              { number: 3, title: 'Roadmap', closed: false, owner: { login: 'acme' } },
              { number: 4, title: 'Done', closed: true, owner: { login: 'acme' } },
              null,
            ],
          },
        },
      },
    );
    expect(options).toEqual({
      labels: [{ name: 'bug', color: 'd73a4a' }],
      users: [{ login: 'octo', avatar_url: 'https://a/octo' }],
      milestones: [{ title: 'v1' }],
      types: [{ name: 'Bug', color: 'RED' }],
      projects: [{ owner: 'acme', number: 3, title: 'Roadmap' }],
    });
  });

  test('without the projects response the other options still come back', () => {
    const options = mapIssueFilterOptions(
      {
        repository: {
          labels: null,
          assignableUsers: null,
          milestones: null,
          issueTypes: null,
        },
      },
      null,
    );
    expect(options.projects).toEqual([]);
    expect(options.labels).toEqual([]);
  });
});
