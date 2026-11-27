import {
  BarChart3,
  Columns3,
  Factory,
  FlaskConical,
  Globe,
  Inbox,
  LayoutGrid,
  MessagesSquare,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { memo, startTransition, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ShortcutHint } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAutomationInbox } from '@/data/automations/hooks';
import { useProjects } from '@/data/projects/hooks';
import { usePanelParam } from '@/hooks/use-panel-param';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import { useRightPaneProjectId } from '@/hooks/use-right-pane-target';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import * as variant from '@/lib/thread-variant';
import { TOOL_PANELS, type ToolPanelContext, type ToolPanelDef } from '@/lib/tool-panels/registry';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useThreadId, useThreadSelector, useThreadWorktreePath } from '@/stores/thread-context';
import { useThreadHistoryStore } from '@/stores/thread-history-store';
import { selectRightPanel, useUIStore, type LeftPanelMode } from '@/stores/ui-store';

/** What the registry's availability rules need, for the thread the rail acts on. */
function useToolPanelContext(): ToolPanelContext {
  const threadId = useThreadId();
  const projectId = useRightPaneProjectId();
  const selfUserId = useAuthStore((s) => s.user?.id ?? null);
  const scratch = useThreadSelector((thread) => variant.isScratch(thread));
  const canShowGit = useThreadSelector(
    (thread) =>
      variant.canDoGitOps(thread) &&
      !(
        !!selfUserId &&
        variant.isReadOnlyShare(thread, selfUserId) &&
        !variant.canViewGitShare(thread, selfUserId)
      ),
  );
  const canShowComments = useThreadSelector((thread) => variant.canShowComments(thread));
  return { hasThread: !!threadId, projectId, scratch, canShowGit, canShowComments };
}

interface RailButtonProps {
  active: boolean;
  children: ReactNode;
  disabled?: boolean;
  /** The accessible name; `label` is the tooltip and may add a shortcut. */
  ariaLabel: string;
  label: ReactNode;
  onClick: () => void;
  testId: string;
}

function RailButton({
  active,
  ariaLabel,
  children,
  disabled,
  label,
  onClick,
  testId,
}: RailButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? 'active' : 'muted'}
          size="icon-sm"
          onClick={onClick}
          disabled={disabled}
          aria-pressed={active}
          aria-label={ariaLabel}
          data-testid={testId}
          className="relative"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

/** The comment count badge: up to 99, then "99+". */
const countLabel = (count: number) => (count > 99 ? '99+' : count);

function PanelButton({
  panel,
  active,
  disabled,
}: {
  panel: ToolPanelDef;
  active: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const togglePanel = useUIStore((s) => s.togglePanel);
  const setPanelParam = usePanelParam();
  const commentCount = useThreadSelector((thread) => thread?.commentCount ?? 0);
  const title = t(panel.titleKey, panel.titleFallback);
  const Icon = panel.icon;
  return (
    <RailButton
      active={active}
      testId={`tool-rail-${panel.id}`}
      ariaLabel={title}
      disabled={disabled}
      onClick={() =>
        startTransition(() => {
          togglePanel(panel.id);
          setPanelParam(active ? null : panel.id);
        })
      }
      label={
        panel.altKey ? (
          <ShortcutHint label={title} keys={['Alt', panel.altKey.toUpperCase()]} />
        ) : (
          title
        )
      }
    >
      <Icon className="icon-base" />
      {panel.id === 'comments' && commentCount > 0 && (
        <span
          className="bg-status-info text-background text-4xs absolute -top-0.5 -right-0.5 rounded-full px-1 leading-tight"
          data-testid="tool-rail-comments-count"
        >
          {countLabel(commentCount)}
        </span>
      )}
    </RailButton>
  );
}

function TestsButton({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const testRunnerOpen = useUIStore((s) => s.testRunnerOpen);
  const setTestRunnerOpen = useUIStore((s) => s.setTestRunnerOpen);
  const setPanelParam = usePanelParam();
  return (
    <RailButton
      active={testRunnerOpen}
      testId="tool-rail-tests"
      ariaLabel={t('tests.title', 'Tests')}
      disabled={disabled}
      onClick={() =>
        startTransition(() => {
          const opening = !testRunnerOpen;
          setTestRunnerOpen(opening);
          setPanelParam(opening ? 'tests' : null);
        })
      }
      label={t('tests.title', 'Tests')}
    >
      <FlaskConical className="icon-base" />
    </RailButton>
  );
}

function TerminalButton({ projectId, disabled }: { projectId: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const worktreePath = useThreadWorktreePath();
  const projects = useProjects();
  const { isTauri } = usePreviewWindow();
  const visible = useTerminalStore((s) => s.panelVisibleByProject[projectId] ?? false);
  const hasTabs = useTerminalStore((s) => s.tabs.some((tab) => tab.projectId === projectId));
  const addTab = useTerminalStore((s) => s.addTab);
  const setPanelVisible = useTerminalStore((s) => s.setPanelVisible);
  const toggleTerminalPanel = useTerminalStore((s) => s.togglePanel);
  return (
    <RailButton
      active={visible}
      testId="tool-rail-terminal"
      ariaLabel={t('terminal.toggle', 'Toggle Terminal')}
      disabled={disabled}
      onClick={() => {
        if (hasTabs || visible) {
          toggleTerminalPanel(projectId);
          return;
        }
        const project = projects.find((p) => p.id === projectId);
        addTab({
          id: crypto.randomUUID(),
          label: 'Terminal 1',
          cwd: worktreePath || project?.path || 'C:\\',
          alive: true,
          projectId,
          type: isTauri ? undefined : 'pty',
        });
        setPanelVisible(projectId, true);
      }}
      label={<ShortcutHint label={t('terminal.toggle', 'Toggle Terminal')} keys={['Ctrl', '`']} />}
    >
      <Terminal className="icon-base" />
    </RailButton>
  );
}

function BrowserButton({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const open = useBrowserPanelStore((s) => s.open);
  const togglePanel = useBrowserPanelStore((s) => s.togglePanel);
  return (
    <RailButton
      active={open}
      testId="tool-rail-browser"
      ariaLabel={t('preview.browser')}
      disabled={disabled}
      onClick={togglePanel}
      label={t('preview.browser')}
    >
      <Globe className="icon-base" />
    </RailButton>
  );
}

/** The views the left sidebar can show, in rail order. */
const LEFT_VIEWS: readonly {
  mode: LeftPanelMode;
  icon: LucideIcon;
  labelKey: string;
  labelFallback: string;
}[] = [
  {
    mode: 'threads',
    icon: MessagesSquare,
    labelKey: 'sidebar.threadsView',
    labelFallback: 'Threads',
  },
  { mode: 'kanban', icon: Columns3, labelKey: 'sidebar.kanbanView', labelFallback: 'Kanban' },
  { mode: 'factory', icon: Factory, labelKey: 'sidebar.factory', labelFallback: 'Factory queue' },
];

/**
 * Where leaving the grid lands: the thread that was open before it (the grid
 * has no thread in its URL), so the center is not left empty.
 */
function pathBehindGrid(): string {
  const last = useThreadHistoryStore.getState().past.at(-1);
  if (!last) return '/';
  return variant.getThreadRoute({
    id: last.threadId,
    projectId: last.projectId,
    isScratch: last.isScratch,
  });
}

/**
 * Leave the grid or the inbox for the left view just chosen. The board and the
 * queue open alone, with no thread beside them (opening a thread from them
 * brings the thread back, App.tsx), so they land on the home page. The thread
 * list and the inbox column go back to the thread that was open before. The
 * grid's flag and the URL change in the same click (see PageButton).
 */
function leaveOtherViewsFor(
  nextMode: LeftPanelMode,
  open: { grid: boolean; inbox: boolean },
  navigate: (path: string) => void,
) {
  if (open.grid) useUIStore.getState().setLiveColumnsOpen(false);
  if (nextMode === 'kanban' || nextMode === 'factory') navigate(buildPath('/'));
  else if (open.grid || open.inbox) navigate(buildPath(pathBehindGrid()));
}

/**
 * Shows one view in the left sidebar: the thread list, the kanban board or
 * the factory queue. Pressing the active board or queue goes back to the
 * thread list. The board and the queue open alone, filling the window with no
 * thread; opening a thread from them moves them into the sidebar beside it.
 * The thread list keeps the thread in the center, except when leaving the
 * grid, which goes back to the thread that was open before it.
 */
function LeftViewButton({
  view,
  onShowSidebar,
}: {
  view: (typeof LEFT_VIEWS)[number];
  onShowSidebar?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const gridOpen = useUIStore((s) => s.liveColumnsOpen);
  // The views are one choice: while the grid is shown, none of these is lit.
  const inboxOpen = useUIStore((s) => s.automationInboxOpen);
  const active = useUIStore(
    (s) => !s.liveColumnsOpen && !s.automationInboxOpen && s.leftPanelMode === view.mode,
  );
  const setLeftPanelMode = useUIStore((s) => s.setLeftPanelMode);
  const label = t(view.labelKey, view.labelFallback);
  const Icon = view.icon;
  return (
    <RailButton
      active={active}
      testId={`tool-rail-${view.mode}`}
      ariaLabel={label}
      onClick={() => {
        const closing = active && view.mode !== 'threads';
        const nextMode = closing ? 'threads' : view.mode;
        setLeftPanelMode(nextMode);
        leaveOtherViewsFor(nextMode, { grid: gridOpen, inbox: inboxOpen }, navigate);
        if (!closing) onShowSidebar?.();
      }}
      label={label}
    >
      <Icon className="icon-base" />
    </RailButton>
  );
}

/**
 * Opens the automation inbox, which fills the window beside the rail. Opening
 * a thread from it moves the inbox into the left sidebar, as a column beside
 * the thread (like the factory queue). Pressing the button while the inbox
 * shows closes it: back to the thread open before, with the thread list. The badge counts the pending runs; the
 * app shell polls them (`useAutomationInboxPolling`).
 */
function InboxButton() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const fullWindow = useUIStore((s) => s.automationInboxOpen);
  const inSidebar = useUIStore((s) => s.leftPanelMode === 'inbox');
  const setLeftPanelMode = useUIStore((s) => s.setLeftPanelMode);
  const { pendingCount } = useAutomationInbox();
  const label = t('automationInbox.title', 'Automation Inbox');
  return (
    <RailButton
      active={fullWindow || inSidebar}
      testId="tool-rail-inbox"
      ariaLabel={label}
      onClick={() => {
        // Pressing it while the inbox shows (full window or beside a thread)
        // closes it and brings the thread list back.
        if (inSidebar) setLeftPanelMode('threads');
        if (fullWindow) navigate(buildPath(pathBehindGrid()));
        else if (!inSidebar) navigate(buildPath('/inbox'));
      }}
      label={label}
    >
      <Inbox className="icon-base" />
      {pendingCount > 0 && (
        <span
          className="text-3xs absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-white px-0.5 leading-none font-medium text-black"
          data-testid="tool-rail-inbox-badge"
        >
          {countLabel(pendingCount)}
        </span>
      )}
    </RailButton>
  );
}

interface RailPage {
  id: 'grid' | 'analytics';
  path: string;
  icon: LucideIcon;
  labelKey: string;
  labelFallback: string;
}

/** The thread grid: a view, so it sits with the sidebar views. */
const GRID_PAGE: RailPage = {
  id: 'grid',
  path: '/grid',
  icon: LayoutGrid,
  labelKey: 'sidebar.grid',
  labelFallback: 'Grid',
};

const ANALYTICS_PAGE: RailPage = {
  id: 'analytics',
  path: '/analytics',
  icon: BarChart3,
  labelKey: 'sidebar.analytics',
  labelFallback: 'Analytics',
};

/**
 * Opens a page (the thread grid, analytics) through its URL. Pressing
 * analytics again while it is open goes back home; the grid is a view like the
 * thread list, so pressing it while it is shown does nothing.
 *
 * The grid's open flag is set in the same click as the URL: the route sync
 * would only set it after a render in which the URL (`/grid`, no thread) and
 * the flag (closed) disagree, and in that render the app follows no thread, so
 * the rail's thread tools vanish and come back.
 */
function PageButton({ page }: { page: RailPage }) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const active = useUIStore((s) => (page.id === 'grid' ? s.liveColumnsOpen : s.analyticsOpen));
  const setLeftPanelMode = useUIStore((s) => s.setLeftPanelMode);
  const setLiveColumnsOpen = useUIStore((s) => s.setLiveColumnsOpen);
  const label = t(page.labelKey, page.labelFallback);
  const Icon = page.icon;
  return (
    <RailButton
      active={active}
      testId={`tool-rail-${page.id}`}
      ariaLabel={label}
      onClick={() => {
        if (page.id === 'grid') {
          if (active) return;
          // The grid is its own view, with the thread list beside it.
          setLeftPanelMode('threads');
          setLiveColumnsOpen(true);
        }
        navigate(buildPath(active ? '/' : page.path));
      }}
      label={label}
    >
      <Icon className="icon-base" />
    </RailButton>
  );
}

/**
 * The tool rail (openspec `tool-panels`): a column of icons at the right edge
 * of the window. The panel icons come from the registry and open, switch or
 * close the right panel; below them, the test runner, terminal and browser;
 * then the views (thread list, kanban board and factory queue in the left
 * sidebar, and the full-screen thread grid); last, the automation inbox and
 * analytics.
 * Rendered inside a `ThreadProvider` for the thread the right pane acts on.
 */
export const ToolRail = memo(function ToolRail({
  className,
  viewsOnly = false,
  onShowSidebar,
}: {
  className?: string;
  /** Expands the left sidebar when one of its views is chosen. */
  onShowSidebar?: () => void;
  /** Nothing to act on (no thread and no selected project): only the view
   *  toggles work. */
  viewsOnly?: boolean;
}) {
  const ctx = useToolPanelContext();
  const threadStatus = useThreadSelector((thread) => thread?.status);
  const rightPanel = useUIStore(selectRightPanel);
  const threadId = useThreadId();
  // The rail keeps one shape: every icon is always there, and one that does
  // not apply (a scratch thread's review, a thread still setting up) is
  // disabled. Adding and removing icons made the rail jump on every switch.
  const noTools = viewsOnly || threadStatus === 'setting_up';
  const noProjectTools = noTools || ctx.scratch || !ctx.projectId;

  return (
    <nav
      aria-label="Tools"
      data-testid="tool-rail"
      className={cn(
        'bg-sidebar border-border flex w-10 shrink-0 flex-col items-center gap-1 border-l py-2',
        className,
      )}
    >
      {TOOL_PANELS.map((panel) => {
        const disabled = noTools || !panel.isAvailable(ctx);
        return (
          <PanelButton
            key={panel.id}
            panel={panel}
            active={!disabled && rightPanel === panel.id}
            disabled={disabled}
          />
        );
      })}
      <Separator className="my-1 w-6" />
      <TestsButton disabled={noProjectTools} />
      <TerminalButton projectId={ctx.projectId ?? ''} disabled={noProjectTools} />
      <BrowserButton disabled={noTools || !(threadId || ctx.projectId)} />
      <Separator className="my-1 w-6" />
      {LEFT_VIEWS.map((view) => (
        <LeftViewButton key={view.mode} view={view} onShowSidebar={onShowSidebar} />
      ))}
      <PageButton page={GRID_PAGE} />
      <Separator className="my-1 w-6" />
      <InboxButton />
      <PageButton page={ANALYTICS_PAGE} />
    </nav>
  );
});
