import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useAutomationStore } from '@/stores/automation-store';
import { useUIStore } from '@/stores/ui-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { Check, ChevronsUpDown, Inbox, Settings, Search } from 'lucide-react';
import type { RunTriageStatus } from '@a-parallel/shared';

export function AutomationInboxView() {
  const navigate = useNavigate();
  const projects = useProjectStore(s => s.projects);

  const inbox = useAutomationStore(s => s.inbox);
  const inboxCount = useAutomationStore(s => s.inboxCount);
  const loadInbox = useAutomationStore(s => s.loadInbox);
  const triageRun = useAutomationStore(s => s.triageRun);

  const setAutomationInboxOpen = useUIStore(s => s.setAutomationInboxOpen);
  const selectThread = useThreadStore(s => s.selectThread);
  const selectedThreadId = useThreadStore(s => s.selectedThreadId);

  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [triageStatusFilter, setTriageStatusFilter] = useState<RunTriageStatus | 'all'>('pending');
  const [searchQuery, setSearchQuery] = useState('');

  // Always load all inbox items so tab counts stay accurate; filter client-side
  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  const filteredInbox = useMemo(() => {
    let items = inbox;

    // Filter by triage status
    if (triageStatusFilter !== 'all') {
      items = items.filter(item => item.run.triageStatus === triageStatusFilter);
    }

    // Filter by project
    if (filterProjectId) {
      items = items.filter(item => item.thread.projectId === filterProjectId);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      items = items.filter(item =>
        item.automation.name.toLowerCase().includes(query) ||
        item.thread.title.toLowerCase().includes(query) ||
        item.run.summary?.toLowerCase().includes(query)
      );
    }

    return items;
  }, [inbox, triageStatusFilter, filterProjectId, searchQuery]);

  // Build list of projects that have inbox items
  const projectsWithItems = useMemo(() => {
    const ids = new Set(inbox.map(item => item.thread.projectId));
    return projects.filter(p => ids.has(p.id));
  }, [inbox, projects]);

  const handleSelectItem = (threadId: string) => {
    selectThread(threadId);
  };

  const handleGoToSettings = () => {
    setAutomationInboxOpen(false);
    if (filterProjectId) {
      navigate(`/projects/${filterProjectId}/settings/automations`);
    } else {
      navigate('/settings/automations');
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Inbox className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">
            Automation Inbox
          </h2>
          {inboxCount > 0 && (
            <Badge className="h-5 min-w-5 justify-center rounded-full px-1 text-[10px] leading-none">
              {inboxCount}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1.5 text-muted-foreground"
          onClick={handleGoToSettings}
        >
          <Settings className="h-3.5 w-3.5" />
          Manage Automations
        </Button>
      </div>

      {/* Triage Status Filter Tabs */}
      <div className="flex items-center gap-0 px-6 border-b border-border/40">
        {(['all', 'pending', 'reviewed', 'dismissed'] as const).map((status) => {
          const isActive = triageStatusFilter === status;
          const count = status === 'all'
            ? inbox.length
            : inbox.filter(item => item.run.triageStatus === status).length;

          return (
            <button
              key={status}
              onClick={() => setTriageStatusFilter(status)}
              className={cn(
                'px-4 py-2 text-xs font-medium transition-colors relative border-b-2',
                isActive
                  ? 'text-foreground border-primary'
                  : 'text-muted-foreground border-transparent hover:text-foreground/80'
              )}
            >
              {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
              {count > 0 && (
                <span className={cn(
                  'ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
                )}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search Bar */}
      <div className="px-6 py-3 border-b border-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by automation name, thread title, or summary..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-8 pl-9 pr-3 text-xs bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* Project filter */}
      {projectsWithItems.length > 1 && (
        <div className="flex items-center gap-2 px-6 py-2 border-b border-border">
          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={filterOpen}
                className="h-7 w-[200px] justify-between text-xs font-normal"
              >
                {filterProjectId
                  ? projectsWithItems.find(p => p.id === filterProjectId)?.name
                  : 'All projects'}
                <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[200px] p-0" align="start">
              <Command>
                <CommandInput placeholder="Search project..." className="h-8 text-xs" />
                <CommandList>
                  <CommandEmpty className="py-3 text-xs">No project found.</CommandEmpty>
                  <CommandGroup>
                    <CommandItem
                      value="all"
                      onSelect={() => { setFilterProjectId(null); setFilterOpen(false); }}
                      className="text-xs"
                    >
                      <Check className={cn('mr-2 h-3 w-3', !filterProjectId ? 'opacity-100' : 'opacity-0')} />
                      All projects
                    </CommandItem>
                    {projectsWithItems.map(p => (
                      <CommandItem
                        key={p.id}
                        value={p.name}
                        onSelect={() => { setFilterProjectId(p.id); setFilterOpen(false); }}
                        className="text-xs"
                      >
                        <Check className={cn('mr-2 h-3 w-3', filterProjectId === p.id ? 'opacity-100' : 'opacity-0')} />
                        {p.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {filteredInbox.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Inbox className="h-8 w-8 mb-3 opacity-50" />
            <p className="text-sm">No pending reviews.</p>
            <p className="text-xs mt-1">Automation results that need review will appear here.</p>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto space-y-3">
            {filteredInbox.map(({ run, automation, thread }) => {
              const itemProject = projects.find(p => p.id === thread.projectId);
              return (
                <div
                  key={run.id}
                  className={cn(
                    'rounded-lg border bg-card p-4 space-y-3 cursor-pointer transition-colors',
                    selectedThreadId === thread.id
                      ? 'border-primary/50 bg-accent/30'
                      : 'border-border/50 hover:border-border'
                  )}
                  onClick={() => handleSelectItem(thread.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{automation.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {itemProject && (
                          <span className="font-medium">{itemProject.name} · </span>
                        )}
                        {thread.title}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded-full',
                        run.hasFindings
                          ? 'bg-amber-500/10 text-amber-500'
                          : 'bg-muted text-muted-foreground'
                      )}>
                        {run.hasFindings ? 'Has findings' : 'No findings'}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {run.completedAt ? new Date(run.completedAt).toLocaleString() : ''}
                      </span>
                    </div>
                  </div>
                  {run.summary && (
                    <p className="text-xs text-muted-foreground">{run.summary}</p>
                  )}
                  <div className="flex items-center gap-2 justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAutomationInboxOpen(false);
                        navigate(`/projects/${thread.projectId}/threads/${thread.id}`);
                      }}
                    >
                      View Thread
                    </Button>
                    {run.triageStatus === 'pending' && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={(e) => { e.stopPropagation(); triageRun(run.id, 'dismissed'); }}
                        >
                          Dismiss
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={(e) => { e.stopPropagation(); triageRun(run.id, 'reviewed'); }}
                        >
                          Mark Reviewed
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
