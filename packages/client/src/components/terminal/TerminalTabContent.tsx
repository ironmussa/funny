import { CommandTabContent } from '@/components/terminal/CommandTabContent';
import { JobLogTabContent } from '@/components/terminal/JobLogTabContent';
import { TauriTerminalTabContent } from '@/components/terminal/TauriTerminalTabContent';
import { WebTerminalTabContent } from '@/components/terminal/WebTerminalTabContent';
import { isTauri } from '@/components/terminal/xterm-utils';
import type { TerminalTab } from '@/stores/terminal-store';

/** The content view for one terminal tab, chosen by the tab's type. */
export function TerminalTabContent({
  tab,
  active,
  panelVisible,
}: {
  tab: TerminalTab;
  active: boolean;
  panelVisible: boolean;
}) {
  if (tab.type === 'pty') {
    return (
      <WebTerminalTabContent
        id={tab.id}
        cwd={tab.cwd}
        active={active}
        panelVisible={panelVisible}
        shell={tab.shell}
        restored={tab.restored}
        projectId={tab.projectId}
        label={tab.label}
        initialCommand={tab.initialCommand}
        scratchThreadId={tab.scratchThreadId}
      />
    );
  }
  return (
    processTabContent(tab, active) ??
    (isTauri ? <TauriTerminalTabContent id={tab.id} cwd={tab.cwd} active={active} /> : null)
  );
}

/** A background job's log or a project command's output; `null` for any other tab. */
function processTabContent(tab: TerminalTab, active: boolean) {
  if (tab.type === 'job-log' && tab.jobId) {
    return <JobLogTabContent tabId={tab.id} jobId={tab.jobId} active={active} />;
  }
  if (tab.commandId) {
    return (
      <CommandTabContent
        commandId={tab.commandId}
        projectId={tab.projectId}
        active={active}
        alive={tab.alive}
      />
    );
  }
  return null;
}
