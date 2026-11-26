/**
 * The run's agent threads in its card's three-dot menu on the factory board:
 * one item per role (triage, implementer, reviewer), each opening its thread.
 * The card shows no powerline: each thread has its own worktree, so the menu
 * names the threads instead of one branch.
 */
import { MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { useThreadById } from '@/lib/thread-selectors';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';

import {
  factoryRunThreadLinks,
  type FactoryRunThreadLink,
  type FactoryRunThreadRole,
} from './run-detail/thread-links';

/**
 * The threads a card links to: the latest thread of each role. A run may have
 * several of one role (a reviewer per reviewed commit, an implementer per
 * retry); the run's panel lists them all.
 */
export function factoryRunCardThreadLinks(
  run: Pick<FactoryQueueRun, 'triage' | 'stepOptions' | 'reviews' | 'roleThreads'>,
): FactoryRunThreadLink[] {
  const links = factoryRunThreadLinks(run);
  return links.filter((link) => links.findLast((other) => other.role === link.role) === link);
}

function ThreadMenuItem({ projectId, link }: { projectId: string; link: FactoryRunThreadLink }) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const thread = useThreadById(link.threadId);
  const roles: Record<FactoryRunThreadRole, string> = {
    triage: t('factoryRunDetail.role.triage', 'Triage'),
    implementer: t('factoryRunDetail.role.implementer', 'Implementer'),
    reviewer: t('factoryRunDetail.role.reviewer', 'Reviewer'),
    agent: t('factoryRunDetail.role.agent', 'Agent'),
  };
  return (
    <DropdownMenuItem
      data-testid={`factory-board-thread-link-${link.threadId}`}
      title={thread?.title}
      onClick={(event) => {
        // The card itself opens the run's panel.
        event.stopPropagation();
        navigate(buildPath(getThreadRoute({ id: link.threadId, projectId, isScratch: false })));
      }}
    >
      <MessageSquare className="icon-sm" />
      {roles[link.role]}
    </DropdownMenuItem>
  );
}

/** The menu's group of the run's threads; nothing when the run has no thread yet. */
export function FactoryRunThreadMenuItems({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const links = factoryRunCardThreadLinks(run);
  if (links.length === 0) return null;
  return (
    <>
      <DropdownMenuLabel>{t('factoryRunDetail.threads', 'Agent threads')}</DropdownMenuLabel>
      {links.map((link) => (
        <ThreadMenuItem key={link.threadId} projectId={run.projectId} link={link} />
      ))}
    </>
  );
}
