/**
 * The run's agent threads in its card's three-dot menu on the factory board:
 * one item per role (triage, implementer, reviewer), each opening its thread.
 * The card shows no powerline: each thread has its own worktree, so the menu
 * names the threads instead of one branch.
 */
import { MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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

function useRoleLabels(): Record<FactoryRunThreadRole, string> {
  const { t } = useTranslation();
  return {
    triage: t('factoryRunDetail.role.triage', 'Triage'),
    implementer: t('factoryRunDetail.role.implementer', 'Implementer'),
    reviewer: t('factoryRunDetail.role.reviewer', 'Reviewer'),
    spec: t('factoryRunDetail.role.spec', 'Spec writer'),
    agent: t('factoryRunDetail.role.agent', 'Agent'),
  };
}

/**
 * The thread a card links to on its face: the last one the run started (the
 * triage that asked on the issue, the implementer, the latest reviewer), so a
 * person deciding about the run reads what its agent said in one click.
 */
function factoryRunLastThread(
  run: Pick<FactoryQueueRun, 'triage' | 'stepOptions' | 'reviews' | 'roleThreads'>,
): FactoryRunThreadLink | undefined {
  return factoryRunThreadLinks(run).at(-1);
}

/** The card's link to the run's last thread, named by its role; nothing without a thread. */
export function FactoryRunLastThreadLink({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const roles = useRoleLabels();
  const link = factoryRunLastThread(run);
  const thread = useThreadById(link?.threadId);
  if (!link) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="muted"
          size="2xs"
          // `-my-0.5`: the button (`h-5`) must not make the footer line (`h-4`) taller.
          className="-my-0.5 shrink-0"
          data-testid={`factory-board-last-thread-${run.id}`}
          onClick={(event) => {
            // The card itself opens the run's panel.
            event.stopPropagation();
            navigate(
              buildPath(
                getThreadRoute({ id: link.threadId, projectId: run.projectId, isScratch: false }),
              ),
            );
          }}
        >
          <MessageSquare className="icon-xs" />
          {roles[link.role]}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {thread?.title ?? t('factoryBoard.openThread', 'Open the thread')}
      </TooltipContent>
    </Tooltip>
  );
}

function ThreadMenuItem({ projectId, link }: { projectId: string; link: FactoryRunThreadLink }) {
  const navigate = useStableNavigate();
  const thread = useThreadById(link.threadId);
  const roles = useRoleLabels();
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
