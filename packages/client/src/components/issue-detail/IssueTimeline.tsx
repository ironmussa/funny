import type {
  IssueTimelineActor,
  IssueTimelineEvent,
  IssueTimelineItem,
  IssueTimelineRef,
  PRIssueComment,
} from '@funny/shared';
import type { TFunction } from 'i18next';
import {
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitCommitHorizontal,
  type LucideIcon,
  Pencil,
  Tag,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { AuthorBadge } from '@/components/AuthorBadge';
import { MarkdownBody } from '@/components/MarkdownBody';
import { Badge } from '@/components/ui/badge';
import { LabelBadge } from '@/components/ui/label-badge';
import { LoadingState } from '@/components/ui/loading-state';
import { PR_STATE_ICON, PR_STATE_TEXT_CLASS, type PRState } from '@/lib/git-icons';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { githubRepoOfUrl, openGitHubItem } from '@/stores/github-item-viewer-store';

export type TimelineState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: IssueTimelineItem[] };

interface TimelineContext {
  now: number;
  projectId: string;
  /** `owner/name` of the issue's repository, lower-cased: its items open in funny's views. */
  repo: string | null;
  repoUrl: string | null;
}

/** The issue's comments and events, oldest first, as GitHub's issue page lists them. */
export function IssueTimeline({
  state,
  now,
  projectId,
  repoUrl,
}: {
  state: TimelineState;
  now: number;
  projectId: string;
  repoUrl: string | null;
}) {
  const { t } = useTranslation();
  if (state.status === 'loading') {
    return (
      <LoadingState
        testId="issue-detail-timeline-loading"
        label={t('issues.timeline.loading', 'Loading activity…')}
      />
    );
  }
  if (state.status === 'error') {
    return (
      <p className="text-muted-foreground text-xs" data-testid="issue-detail-timeline-error">
        {t('issues.timeline.error', 'Failed to load activity')}: {state.message}
      </p>
    );
  }
  if (state.items.length === 0) return null;
  const ctx: TimelineContext = {
    now,
    projectId,
    repo: githubRepoOfUrl(repoUrl ?? undefined),
    repoUrl,
  };
  return (
    <div className="flex flex-col gap-2" data-testid="issue-detail-timeline">
      {state.items.map((item, index) =>
        item.type === 'comment' ? (
          <TimelineComment key={`c-${item.comment.id}`} comment={item.comment} ctx={ctx} />
        ) : (
          <TimelineEventRow key={item.id || `e-${index}`} event={item} ctx={ctx} />
        ),
      )}
    </div>
  );
}

function TimelineComment({ comment, ctx }: { comment: PRIssueComment; ctx: TimelineContext }) {
  const { t } = useTranslation();
  return (
    <div
      className="border-border bg-background flex flex-col gap-1.5 rounded-md border p-2"
      data-testid={`issue-detail-comment-${comment.id}`}
    >
      <div className="flex items-center gap-1.5 text-xs">
        <AuthorBadge name={comment.author} avatarUrl={comment.author_avatar_url} size="xs" />
        <TimeLink at={comment.created_at} url={comment.html_url} now={ctx.now} t={t} />
        {comment.author_association && comment.author_association !== 'NONE' && (
          <Badge size="xs" variant="outline">
            {comment.author_association}
          </Badge>
        )}
      </div>
      <MarkdownBody body={comment.body} repoUrl={ctx.repoUrl} />
    </div>
  );
}

function TimeLink({ at, url, now, t }: { at: string; url?: string; now: number; t: TFunction }) {
  const text = timeAgo(at, t, now);
  if (!url) return <span className="text-muted-foreground">{text}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={new Date(at).toLocaleString()}
      className="text-muted-foreground hover:text-foreground hover:underline"
    >
      {text}
    </a>
  );
}

function Actor({ actor }: { actor: IssueTimelineActor | null }) {
  if (!actor) return null;
  return <AuthorBadge name={actor.login} avatarUrl={actor.avatar_url} size="xs" />;
}

/**
 * A linked issue or pull request. One of the issue's own repository opens in
 * funny's view; another repository's goes to GitHub.
 */
function toPRState(state: IssueTimelineRef['state']): PRState {
  if (state === 'merged') return 'MERGED';
  if (state === 'open') return 'OPEN';
  return 'CLOSED';
}

/** The state icon GitHub shows beside a linked issue or pull request. */
function RefStateIcon({ item }: { item: IssueTimelineRef }) {
  if (item.kind === 'pr') {
    const state = toPRState(item.state);
    const StateIcon = PR_STATE_ICON[state];
    return (
      <span className={cn('flex shrink-0', PR_STATE_TEXT_CLASS[state])}>
        <StateIcon className="icon-xs" />
      </span>
    );
  }
  if (item.state === 'open') return <CircleDot className="icon-xs text-status-success shrink-0" />;
  return <CircleCheck className="icon-xs text-status-violet shrink-0" />;
}

function RefLink({
  item,
  ctx,
  withTitle,
}: {
  item: IssueTimelineRef;
  ctx: TimelineContext;
  withTitle?: boolean;
}) {
  const sameRepo = !!ctx.repo && item.repo === ctx.repo;
  const label = sameRepo ? `#${item.number}` : `${item.repo}#${item.number}`;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!sameRepo || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    openGitHubItem({
      kind: item.kind,
      projectId: ctx.projectId,
      number: item.number,
      url: item.url,
    });
  };
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className="text-foreground inline-flex min-w-0 items-center gap-1 hover:underline"
      data-testid={`issue-detail-ref-${item.kind}-${item.number}`}
    >
      {withTitle && <RefStateIcon item={item} />}
      {withTitle && <span className="truncate">{item.title}</span>}
      <span className={cn(withTitle ? 'text-muted-foreground' : 'font-medium')}>{label}</span>
    </a>
  );
}

const STATE_REASON_TEXT = {
  completed: ['issues.timeline.closedCompleted', 'closed this as completed'],
  not_planned: ['issues.timeline.closedNotPlanned', 'closed this as not planned'],
  duplicate: ['issues.timeline.closedDuplicate', 'closed this as a duplicate'],
} as const;

/** What one event row shows: its icon and the icon's fill, the sentence, an optional second line. */
interface EventView {
  icon: LucideIcon;
  iconClass?: string;
  text: ReactNode;
  detail?: ReactNode;
}

function describeEvent(event: IssueTimelineEvent, ctx: TimelineContext, t: TFunction): EventView {
  switch (event.type) {
    case 'labeled':
    case 'unlabeled':
      return {
        icon: Tag,
        text: (
          <>
            {event.type === 'labeled'
              ? t('issues.timeline.added', 'added')
              : t('issues.timeline.removed', 'removed')}
            <LabelBadge color={event.label.color}>{event.label.name}</LabelBadge>
          </>
        ),
      };
    case 'cross-referenced':
      return {
        icon: event.source.kind === 'pr' ? PR_STATE_ICON.OPEN : CircleDot,
        text: event.willClose
          ? t('issues.timeline.linkedToClose', 'linked a pull request that will close this issue')
          : t('issues.timeline.mentioned', 'mentioned this'),
        detail: <RefLink item={event.source} ctx={ctx} withTitle />,
      };
    case 'closed': {
      const [key, fallback] = event.stateReason
        ? STATE_REASON_TEXT[event.stateReason]
        : (['issues.timeline.closed', 'closed this'] as const);
      const notPlanned = event.stateReason === 'not_planned' || event.stateReason === 'duplicate';
      return {
        icon: notPlanned ? CircleSlash : CircleCheck,
        iconClass: cn('text-background', notPlanned ? 'bg-muted-foreground' : 'bg-status-violet'),
        text: (
          <>
            {t(key, fallback)}
            {event.closer && <span>{t('issues.timeline.in', 'in')}</span>}
            {event.closer?.kind === 'pr' && <RefLink item={event.closer.ref} ctx={ctx} />}
            {event.closer?.kind === 'commit' && (
              <a
                href={event.closer.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono hover:underline"
              >
                {event.closer.sha.slice(0, 7)}
              </a>
            )}
          </>
        ),
      };
    }
    case 'reopened':
      return {
        icon: CircleDot,
        iconClass: 'bg-status-success text-background',
        text: t('issues.timeline.reopened', 'reopened this'),
      };
    case 'renamed':
      return {
        icon: Pencil,
        text: (
          <>
            {t('issues.timeline.renamed', 'changed the title')}
            <span className="line-through">{event.from}</span>
            <span className="text-foreground">{event.to}</span>
          </>
        ),
      };
    case 'assigned':
    case 'unassigned': {
      const self = !!event.assignee && event.assignee.login === event.actor?.login;
      const assigned = event.type === 'assigned';
      return {
        icon: assigned ? UserPlus : UserMinus,
        text: self ? (
          assigned ? (
            t('issues.timeline.selfAssigned', 'self-assigned this')
          ) : (
            t('issues.timeline.selfUnassigned', 'removed their assignment')
          )
        ) : (
          <>
            {assigned
              ? t('issues.timeline.assigned', 'assigned')
              : t('issues.timeline.unassigned', 'unassigned')}
            <Actor actor={event.assignee} />
          </>
        ),
      };
    }
    case 'commit-referenced':
      return {
        icon: GitCommitHorizontal,
        text: t('issues.timeline.commitReferenced', 'added a commit that referenced this issue'),
        detail: (
          <a
            href={event.commit.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1.5 hover:underline"
          >
            <span className="text-foreground truncate">{event.commit.message}</span>
            <span className="text-muted-foreground font-mono">{event.commit.sha.slice(0, 7)}</span>
          </a>
        ),
      };
  }
}

function TimelineEventRow({ event, ctx }: { event: IssueTimelineEvent; ctx: TimelineContext }) {
  const { t } = useTranslation();
  const { icon: Icon, iconClass, text, detail } = describeEvent(event, ctx, t);
  return (
    <div
      className="flex items-start gap-2 px-1 py-0.5 text-xs"
      data-testid={`issue-detail-event-${event.type}`}
    >
      <span
        className={cn(
          'bg-muted text-muted-foreground flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
          iconClass,
        )}
      >
        <Icon className="icon-xs" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
        <div className="text-muted-foreground flex flex-wrap items-center gap-1">
          <Actor actor={event.actor} />
          {text}
          <TimeLink at={event.created_at} now={ctx.now} t={t} />
        </div>
        {detail && <div className="flex min-w-0 items-center">{detail}</div>}
      </div>
    </div>
  );
}
