import type { RunTriageStatus } from '@funny/shared';
import { includesSearchText } from '@funny/shared/lib/text-search';
import { ArrowLeft, Inbox, Settings } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ViewThreadsButton } from '@/components/all-threads/ViewThreadsButton';
import { AutomationSettings } from '@/components/AutomationSettings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
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
import { cn } from '@/lib/utils';
import { goToThread } from '@/navigation/go-to-thread';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { InboxItemCard } from './automation-inbox/InboxItemCard';
import { InboxProjectFilter } from './automation-inbox/InboxProjectFilter';

const ALL_PROJECTS = '__all__';

export function AutomationInboxView() {
  const navigate = useNavigate();
  const projects = useProjects();

  const { inbox, pendingCount: inboxCount } = useAutomationInbox();

  const setAutomationInboxOpen = useUIStore((s) => s.setAutomationInboxOpen);
  const selectThread = useThreadStore((s) => s.selectThread);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);

  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterListId = useId();
  const [triageStatusFilter, setTriageStatusFilter] = useState<RunTriageStatus | 'all'>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  // "manage" shows the automation list in place of the inbox, without leaving
  // this view for Settings.
  const [mode, setMode] = useState<'inbox' | 'manage'>('inbox');
  // A project id, or ALL_PROJECTS for every project's automations.
  const [manageProjectId, setManageProjectId] = useState<string | null>(null);

  // Always load all inbox items so tab counts stay accurate; filter client-side
  useEffect(() => {
    void loadInbox();
  }, []);

  const filteredInbox = useMemo(() => {
    let items = inbox;

    // Filter by triage status
    if (triageStatusFilter !== 'all') {
      items = items.filter((item) => item.run.triageStatus === triageStatusFilter);
    }

    // Filter by project
    if (filterProjectId) {
      items = items.filter((item) => item.thread.projectId === filterProjectId);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      items = items.filter(
        (item) =>
          includesSearchText(item.automation.name, searchQuery, searchCaseSensitive) ||
          includesSearchText(item.thread.title, searchQuery, searchCaseSensitive) ||
          (!!item.run.summary &&
            includesSearchText(item.run.summary, searchQuery, searchCaseSensitive)),
      );
    }

    return items;
  }, [inbox, triageStatusFilter, filterProjectId, searchQuery, searchCaseSensitive]);

  // Build list of projects that have inbox items
  const projectsWithItems = useMemo(() => {
    const ids = new Set(inbox.map((item) => item.thread.projectId));
    return projects.filter((p) => ids.has(p.id));
  }, [inbox, projects]);

  const handleSelectItem = (threadId: string) => {
    selectThread(threadId);
  };

  const handleManageAutomations = () => {
    setManageProjectId(filterProjectId ?? ALL_PROJECTS);
    setMode('manage');
  };

  if (mode === 'manage') {
    const showAll = manageProjectId === ALL_PROJECTS;
    const manageProject = projects.find((p) => p.id === manageProjectId);
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="border-border flex items-center justify-between gap-3 border-b px-6 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Back to inbox"
              data-testid="inbox-manage-back"
              onClick={() => setMode('inbox')}
            >
              <ArrowLeft className="icon-sm" />
            </Button>
            <h2 className="text-sm font-medium">Automations</h2>
          </div>
          {projects.length > 0 && (
            <Select
              value={showAll ? ALL_PROJECTS : manageProject?.id}
              onValueChange={setManageProjectId}
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
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="border-border flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <Inbox className="icon-base text-muted-foreground" />
          <h2 className="text-sm font-medium">Automation Inbox</h2>
          {inboxCount > 0 && (
            <Badge variant="secondary" size="count" className="h-5 min-w-5">
              {inboxCount}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <ViewThreadsButton
            origin="automation"
            projectId={filterProjectId}
            testId="inbox-view-threads"
          />
          <Button
            variant="muted"
            size="xs"
            gap="snug"
            data-testid="inbox-manage-automations"
            onClick={handleManageAutomations}
          >
            <Settings className="icon-sm" />
            Manage Automations
          </Button>
        </div>
      </div>
      {/* Triage Status Filter Tabs */}
      <div className="border-border/40 flex items-center gap-0 border-b px-6">
        {(['all', 'pending', 'reviewed', 'dismissed'] as const).map((status) => {
          const isActive = triageStatusFilter === status;
          const count =
            status === 'all'
              ? inbox.length
              : inbox.filter((item) => item.run.triageStatus === status).length;

          return (
            <button
              key={status}
              data-testid={`inbox-tab-${status}`}
              onClick={() => setTriageStatusFilter(status)}
              className={cn(
                'px-4 py-2 text-xs font-medium transition-colors relative border-b-2',
                isActive
                  ? 'text-foreground border-primary'
                  : 'text-muted-foreground border-transparent hover:text-foreground/80',
              )}
            >
              {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
              {count > 0 && (
                <span
                  className={cn(
                    'ml-1.5 text-xs px-1.5 py-0.5 rounded-full',
                    isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* Search Bar */}
      <div className="border-border border-b px-6 py-2">
        <SearchBar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          placeholder="Search by automation name, thread title, or summary..."
          totalMatches={filteredInbox.length}
          resultLabel={searchQuery ? `${filteredInbox.length}/${inbox.length}` : ''}
          caseSensitive={searchCaseSensitive}
          onCaseSensitiveChange={setSearchCaseSensitive}
          onClose={searchQuery ? () => setSearchQuery('') : undefined}
          autoFocus={false}
          testIdPrefix="inbox-search"
        />
      </div>
      {/* Project filter */}{' '}
      {projectsWithItems.length > 1 && (
        <InboxProjectFilter
          projectsWithItems={projectsWithItems}
          filterProjectId={filterProjectId}
          setFilterProjectId={setFilterProjectId}
          filterOpen={filterOpen}
          setFilterOpen={setFilterOpen}
          filterListId={filterListId}
        />
      )}
      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-6">
          {filteredInbox.length === 0 ? (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center">
              <Inbox className="mb-3 size-8 opacity-50" />
              <p className="text-sm">No pending reviews.</p>
              <p className="mt-1 text-xs">Automation results that need review will appear here.</p>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-3">
              {filteredInbox.map(({ run, automation, thread }) => {
                const itemProject = projects.find((p) => p.id === thread.projectId);
                return (
                  <InboxItemCard
                    key={run.id}
                    run={run}
                    automation={automation}
                    thread={thread}
                    itemProject={itemProject}
                    selected={selectedThreadId === thread.id}
                    onSelect={handleSelectItem}
                    onViewThread={(t) => {
                      setAutomationInboxOpen(false);
                      goToThread(navigate, t);
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
