import { FlaskConical, Globe, Terminal } from 'lucide-react';
import { memo, startTransition, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ShortcutHint } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useProjects } from '@/data/projects/hooks';
import { usePanelParam } from '@/hooks/use-panel-param';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import { useRightPaneProjectId } from '@/hooks/use-right-pane-target';
import * as variant from '@/lib/thread-variant';
import { TOOL_PANELS, type ToolPanelContext, type ToolPanelDef } from '@/lib/tool-panels/registry';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useThreadId, useThreadSelector, useThreadWorktreePath } from '@/stores/thread-context';
import { selectRightPanel, useUIStore } from '@/stores/ui-store';

/** What the registry's availability rules need, for the thread the rail acts on. */
export function useToolPanelContext(): ToolPanelContext {
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

function PanelButton({ panel, active }: { panel: ToolPanelDef; active: boolean }) {
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

function TestsButton() {
  const { t } = useTranslation();
  const testRunnerOpen = useUIStore((s) => s.testRunnerOpen);
  const setTestRunnerOpen = useUIStore((s) => s.setTestRunnerOpen);
  const setPanelParam = usePanelParam();
  return (
    <RailButton
      active={testRunnerOpen}
      testId="tool-rail-tests"
      ariaLabel={t('tests.title', 'Tests')}
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

function TerminalButton({ projectId }: { projectId: string }) {
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

function BrowserButton() {
  const { t } = useTranslation();
  const open = useBrowserPanelStore((s) => s.open);
  const togglePanel = useBrowserPanelStore((s) => s.togglePanel);
  return (
    <RailButton
      active={open}
      testId="tool-rail-browser"
      ariaLabel={t('preview.browser')}
      onClick={togglePanel}
      label={t('preview.browser')}
    >
      <Globe className="icon-base" />
    </RailButton>
  );
}

/**
 * The tool rail (openspec `tool-panels`): a column of icons at the right edge
 * of the window. The panel icons come from the registry and open, switch or
 * close the right panel; below them, the test runner, terminal and browser.
 * Rendered inside a `ThreadProvider` for the thread the right pane acts on.
 */
export const ToolRail = memo(function ToolRail({ className }: { className?: string }) {
  const ctx = useToolPanelContext();
  const threadStatus = useThreadSelector((thread) => thread?.status);
  const rightPanel = useUIStore(selectRightPanel);
  const threadId = useThreadId();
  const panels = TOOL_PANELS.filter((panel) => panel.isAvailable(ctx));
  const showProjectTools = !ctx.scratch && !!ctx.projectId;
  if (threadStatus === 'setting_up') return null;

  return (
    <nav
      aria-label="Tools"
      data-testid="tool-rail"
      className={cn(
        'bg-sidebar border-border flex w-10 shrink-0 flex-col items-center gap-1 border-l py-2',
        className,
      )}
    >
      {panels.map((panel) => (
        <PanelButton key={panel.id} panel={panel} active={rightPanel === panel.id} />
      ))}
      {(showProjectTools || threadId) && <Separator className="my-1 w-6" />}
      {showProjectTools && <TestsButton />}
      {showProjectTools && ctx.projectId && <TerminalButton projectId={ctx.projectId} />}
      {(threadId || ctx.projectId) && <BrowserButton />}
    </nav>
  );
});
