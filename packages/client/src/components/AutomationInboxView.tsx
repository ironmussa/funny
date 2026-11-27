import { ArrowLeft, Inbox, Settings } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { AutomationSettings } from '@/components/AutomationSettings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAutomationInbox } from '@/data/automations/hooks';
import { loadInbox } from '@/data/automations/loaders';
import { useProjects } from '@/data/projects/hooks';
import { parseRoute } from '@/hooks/route-parser';
import { useActiveThreadId } from '@/hooks/use-active-thread-id';
import { useLeftViewPath } from '@/hooks/use-left-view';
import { buildPath } from '@/lib/url';
import { goToThread } from '@/navigation/go-to-thread';

import { InboxRunList } from './automation-inbox/InboxRunList';
import { InboxToolbar } from './automation-inbox/InboxToolbar';
import { useInboxFilters } from './automation-inbox/use-inbox-filters';
import { useInboxSelection } from './automation-inbox/use-inbox-selection';

const ALL_PROJECTS = '__all__';
/** Query param of `/inbox/automations` naming the project shown; absent = all projects. */
const MANAGE_PROJECT_PARAM = 'project';

export function AutomationInboxView() {
  // A thread opened from the inbox keeps the inbox beside it (`?left=inbox`).
  const besideInbox = useLeftViewPath();
  const { t } = useTranslation();
  const activeThreadId = useActiveThreadId();
  const navigate = useNavigate();
  const projects = useProjects();

  const { inbox, pendingCount: inboxCount } = useAutomationInbox();

  const filters = useInboxFilters(inbox);
  const selection = useInboxSelection(filters.filtered);
  // `/inbox/automations` shows the automation list in place of the inbox,
  // without leaving this view for Settings. Its project is `?project=<id>`
  // (absent: every project's automations), so the view can be linked to.
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const mode = parseRoute(location.pathname).inboxAutomations ? 'manage' : 'inbox';
  const manageProjectId = searchParams.get(MANAGE_PROJECT_PARAM) ?? ALL_PROJECTS;

  const openManage = (projectId: string | null, replace = false) => {
    const query =
      projectId && projectId !== ALL_PROJECTS
        ? `?${new URLSearchParams({ [MANAGE_PROJECT_PARAM]: projectId })}`
        : '';
    navigate(buildPath(`/inbox/automations${query}`), { replace });
  };

  // Always load all inbox items so tab counts stay accurate; filter client-side
  useEffect(() => {
    void loadInbox();
  }, []);

  // Build list of projects that have inbox items
  const projectsWithItems = useMemo(() => {
    const ids = new Set(inbox.map((item) => item.thread.projectId));
    return projects.filter((p) => ids.has(p.id));
  }, [inbox, projects]);

  const handleManageAutomations = () => openManage(filters.projectFilter);

  if (mode === 'manage') {
    const manageProject = projects.find((p) => p.id === manageProjectId);
    // An unknown `?project=` (deleted, or not the caller's) falls back to all.
    const showAll = !manageProject;
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="border-border flex items-center justify-between gap-3 border-b px-6 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Back to inbox"
              data-testid="inbox-manage-back"
              onClick={() => navigate(buildPath('/inbox'))}
            >
              <ArrowLeft className="icon-sm" />
            </Button>
            <h2 className="text-sm font-medium">Automations</h2>
          </div>
          {projects.length > 0 && (
            <Select
              value={showAll ? ALL_PROJECTS : manageProject?.id}
              onValueChange={(id) => openManage(id, true)}
            >
              <SelectTrigger
                size="xs"
                className="w-[200px]"
                data-testid="inbox-manage-project"
                aria-label="Project"
              >
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <ScrollArea className="flex-1">
          <div className="mx-auto max-w-2xl p-6">
            <AutomationSettings projectId={manageProject?.id ?? null} allProjects={showAll} />
          </div>
        </ScrollArea>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Inbox className="icon-sm text-muted-foreground" />
            {t('automationInbox.title')}
            {inboxCount > 0 && (
              <Badge variant="secondary" size="count" className="h-5 min-w-5">
                {inboxCount}
              </Badge>
            )}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t('automationInbox.subtitle', {
              projects: projectsWithItems.length,
              runs: inbox.length,
            })}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="muted"
            size="xs"
            gap="snug"
            data-testid="inbox-manage-automations"
            onClick={handleManageAutomations}
          >
            <Settings className="icon-sm" />
            {t('automationInbox.manage')}
          </Button>
        </div>
      </div>

      <InboxToolbar
        filters={filters}
        selection={selection}
        projects={projects}
        totalCount={inbox.length}
      />

      <div className="flex min-h-0 flex-1 flex-col px-2 py-1">
        <InboxRunList
          items={filters.filtered}
          search={filters.search.trim()}
          hasFilters={filters.hasActiveFilters}
          selection={selection}
          activeThreadId={activeThreadId}
          // Only navigate: the route sync closes the inbox in the same render
          // as the URL change. Closing it first showed the new-thread input
          // for a frame, since the URL (still /inbox) had no thread yet.
          onOpen={(thread) => goToThread(navigate, thread, { mapPath: besideInbox })}
        />
      </div>
    </div>
  );
}
