/**
 * GitHubTracker — pulls issues from GitHub via the `gh` CLI.
 *
 * Uses `gh` instead of raw HTTP to leverage existing auth
 * (gh auth login) and avoid token management.
 */

import { execute } from '@funny/core/git';

import { logger } from '../infrastructure/logger.js';
import type {
  Tracker,
  Issue,
  IssueDetail,
  IssueFilter,
  IssueComment,
  IssueLabel,
} from './tracker.js';

// ── GitHubTracker ───────────────────────────────────────────────

export class GitHubTracker implements Tracker {
  readonly name = 'github';

  constructor(
    private repo: string,
    private cwd: string,
  ) {}

  /** Auto-detect repo from git remote */
  static async fromCwd(cwd: string): Promise<GitHubTracker> {
    const { stdout } = await execute(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { cwd, reject: false },
    );
    const repo = stdout.trim();
    if (!repo) {
      throw new Error('Could not detect GitHub repo from current directory');
    }
    return new GitHubTracker(repo, cwd);
  }

  async fetchIssues(filter: IssueFilter): Promise<Issue[]> {
    const args = [
      'issue',
      'list',
      '--repo',
      this.repo,
      '--json',
      'number,title,state,body,url,labels,assignees,comments,createdAt,updatedAt',
    ];

    args.push('--state', filter.state ?? 'open');

    if (filter.labels?.length) {
      for (const label of filter.labels) {
        args.push('--label', label);
      }
    }

    if (filter.assignee) {
      args.push('--assignee', filter.assignee);
    }

    if (filter.milestone) {
      args.push('--milestone', filter.milestone);
    }

    args.push('--limit', String(filter.limit ?? 30));

    const { stdout, exitCode } = await execute('gh', args, { cwd: this.cwd, reject: false });
    if (exitCode !== 0 || !stdout.trim()) {
      logger.warn({ repo: this.repo, exitCode }, 'Failed to fetch issues');
      return [];
    }

    const raw = JSON.parse(stdout) as any[];

    let issues = raw.map(
      (item): Issue => ({
        number: item.number,
        title: item.title,
        state: item.state?.toLowerCase() === 'open' ? 'open' : 'closed',
        body: item.body ?? null,
        url: item.url,
        labels: (item.labels ?? []).map(
          (l: any): IssueLabel => ({
            name: l.name,
            color: l.color ?? '',
          }),
        ),
        assignee: item.assignees?.[0]
          ? { login: item.assignees[0].login, avatarUrl: item.assignees[0].avatarUrl }
          : null,
        commentsCount: Array.isArray(item.comments) ? item.comments.length : (item.comments ?? 0),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }),
    );

    // Client-side filtering for excludeLabels (gh CLI doesn't support negation)
    if (filter.excludeLabels?.length) {
      const excludeSet = new Set(filter.excludeLabels);
      issues = issues.filter((i) => !i.labels.some((l) => excludeSet.has(l.name)));
    }

    return issues;
  }

  async fetchIssueDetail(issueNumber: number): Promise<IssueDetail> {
    // Fetch issue details
    const { stdout: issueJson } = await execute(
      'gh',
      [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        this.repo,
        '--json',
        'number,title,state,body,url,labels,assignees,comments,createdAt,updatedAt',
      ],
      { cwd: this.cwd },
    );

    const item = JSON.parse(issueJson);

    const comments: IssueComment[] = (item.comments ?? []).map(
      (c: any): IssueComment => ({
        id: c.id ?? 0,
        author: c.author?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.createdAt ?? '',
      }),
    );

    // Build full context for the orchestrator agent
    const contextParts = [
      `# Issue #${item.number}: ${item.title}`,
      '',
      item.body ?? '(no description)',
    ];

    if (comments.length > 0) {
      contextParts.push('', '## Comments', '');
      for (const c of comments) {
        contextParts.push(`### @${c.author} (${c.createdAt})`, c.body, '');
      }
    }

    return {
      number: item.number,
      title: item.title,
      state:
        item.state?.toLowerCase() === 'OPEN'
          ? 'open'
          : item.state?.toLowerCase() === 'open'
            ? 'open'
            : 'closed',
      body: item.body ?? null,
      url: item.url,
      labels: (item.labels ?? []).map(
        (l: any): IssueLabel => ({
          name: l.name,
          color: l.color ?? '',
        }),
      ),
      assignee: item.assignees?.[0]
        ? { login: item.assignees[0].login, avatarUrl: item.assignees[0].avatarUrl }
        : null,
      commentsCount: comments.length,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      comments,
      fullContext: contextParts.join('\n'),
    };
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    await execute(
      'gh',
      ['issue', 'comment', String(issueNumber), '--repo', this.repo, '--body', body],
      { cwd: this.cwd },
    );
    logger.info({ repo: this.repo, issueNumber }, 'Comment added to issue');
  }

  async updateLabels(issueNumber: number, add: string[], remove?: string[]): Promise<void> {
    const args = ['issue', 'edit', String(issueNumber), '--repo', this.repo];

    if (add.length > 0) {
      args.push('--add-label', add.join(','));
    }
    if (remove?.length) {
      args.push('--remove-label', remove.join(','));
    }

    await execute('gh', args, { cwd: this.cwd });
    logger.info({ repo: this.repo, issueNumber, add, remove }, 'Issue labels updated');
  }

  async assignIssue(issueNumber: number, assignee: string): Promise<void> {
    await execute(
      'gh',
      ['issue', 'edit', String(issueNumber), '--repo', this.repo, '--add-assignee', assignee],
      { cwd: this.cwd },
    );
  }

  async closeIssue(issueNumber: number, comment?: string): Promise<void> {
    if (comment) {
      await this.addComment(issueNumber, comment);
    }
    await execute('gh', ['issue', 'close', String(issueNumber), '--repo', this.repo], {
      cwd: this.cwd,
    });
    logger.info({ repo: this.repo, issueNumber }, 'Issue closed');
  }
}
