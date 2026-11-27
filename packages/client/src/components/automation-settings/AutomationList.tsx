import type { Automation, AutomationRun } from '@funny/shared';
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { AutomationRow } from './AutomationRow';

/** Automations under one project heading; `project` is null for a single-project list. */
export interface AutomationGroup {
  project: { id: string; name: string } | null;
  items: Automation[];
}

/** One group with no heading, or one group per project that has automations. */
export function groupAutomations(
  allProjects: boolean,
  automations: Automation[],
  projects: { id: string; name: string }[],
): AutomationGroup[] {
  if (!allProjects) return [{ project: null, items: automations }];
  return projects.flatMap((project) => {
    const items = automations.filter((a) => a.projectId === project.id);
    return items.length > 0 ? [{ project, items }] : [];
  });
}

export function CreateAutomationButton({
  testId,
  onClick,
  children,
}: {
  testId: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="outline" size="sm" gap="snug" data-testid={testId} onClick={onClick}>
      <Plus className="icon-sm" />
      {children}
    </Button>
  );
}

/** What the rows of the list share: the open run history and the row actions. */
export interface AutomationRowContext {
  runsAutomationId: string | null;
  runs: AutomationRun[];
  triggeringIds: ReadonlySet<string>;
  onTrigger: (a: Automation) => void;
  onToggleEnabled: (a: Automation) => void;
  onViewRuns: (automationId: string) => void;
  onEdit: (a: Automation) => void;
  onDelete: (a: Automation) => void;
  onOpenThread: (a: Automation, threadId: string) => void;
  onCloseRuns: () => void;
}

function AutomationGroupSection({
  group,
  rows,
}: {
  group: AutomationGroup;
  rows: AutomationRowContext;
}) {
  const { project, items } = group;
  return (
    <section
      className={cn(project ? 'space-y-2' : 'space-y-4')}
      data-testid={project ? `automations-group-${project.id}` : undefined}
    >
      {project && <h3 className="text-muted-foreground text-xs font-medium">{project.name}</h3>}
      {items.map((a) => (
        <AutomationRow
          key={a.id}
          a={a}
          runsOpen={rows.runsAutomationId === a.id}
          runs={rows.runs}
          onTrigger={rows.onTrigger}
          triggering={rows.triggeringIds.has(a.id)}
          onToggleEnabled={rows.onToggleEnabled}
          onViewRuns={rows.onViewRuns}
          onEdit={rows.onEdit}
          onDelete={rows.onDelete}
          onOpenThread={(threadId) => rows.onOpenThread(a, threadId)}
          onCloseRuns={rows.onCloseRuns}
        />
      ))}
    </section>
  );
}

export function AutomationGroups({
  groups,
  rows,
}: {
  groups: AutomationGroup[];
  rows: AutomationRowContext;
}) {
  return (
    <>
      {groups.map((group) => (
        <AutomationGroupSection key={group.project?.id ?? 'project'} group={group} rows={rows} />
      ))}
    </>
  );
}
