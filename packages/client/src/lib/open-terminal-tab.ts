import type { Job, Thread } from '@funny/shared';

import { isTauri } from '@/components/terminal/xterm-utils';
import { useProjectStore } from '@/stores/project-store';
import { type TerminalShell, useSettingsStore } from '@/stores/settings-store';
import {
  SCRATCH_TERMINAL_SCOPE_ID,
  type TerminalTab,
  useTerminalStore,
} from '@/stores/terminal-store';

/**
 * Single entry point for the "Open Terminal" menu items in the sidebar,
 * kanban, and project rows. Creates a new dockview bottom-panel tab so all
 * "Open Terminal" actions share the same code path as the panel's "+"
 * button (see `NewTerminalButton` in `TerminalDockview.tsx`).
 *
 * Replaces the legacy `api.openTerminal(...)` flow that spawned an external
 * OS terminal app (gnome-terminal / Terminal.app / cmd) outside the UI.
 */

function buildTab(args: {
  projectId: string;
  cwd: string;
  shell: TerminalShell;
  scratchThreadId?: string;
  /** Command auto-run once the PTY shell is ready (e.g. `tail -f <log>`). */
  initialCommand?: string;
  /** Override the auto-generated "<shell> N" label. */
  label?: string;
}): TerminalTab {
  const { tabs } = useTerminalStore.getState();
  const { availableShells } = useSettingsStore.getState();
  const detected = availableShells.find((s) => s.id === args.shell);
  const shellName = detected?.label ?? 'Terminal';
  const sameShellCount = tabs.filter(
    (t) => t.projectId === args.projectId && (t.shell ?? 'default') === args.shell,
  ).length;
  return {
    id: crypto.randomUUID(),
    label: args.label ?? `${shellName} ${sameShellCount + 1}`,
    cwd: args.cwd,
    alive: true,
    projectId: args.projectId,
    type: isTauri ? undefined : 'pty',
    shell: args.shell,
    createdAt: Date.now(),
    scratchThreadId: args.scratchThreadId,
    initialCommand: args.initialCommand,
  };
}

/** Shell-quote a path for safe interpolation into a single-quoted argument. */
function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Open the existing bottom terminal panel on a tab that shows a background
 * job's output: live-follow (`tail -f`) while running, the captured log
 * (`cat`) once finished. Opened in the CURRENT terminal scope so it surfaces
 * immediately regardless of which project the job belongs to.
 */
export function openJobLogTerminal(args: {
  job: Pick<Job, 'id' | 'logPath' | 'status' | 'label' | 'cwd'>;
  /** Current terminal scope (so the tab shows in the visible panel). */
  projectId: string;
  shell?: TerminalShell;
}): void {
  const { addTab } = useTerminalStore.getState();
  const log = singleQuote(args.job.logPath);
  // -F (vs -f) retries if the logfile isn't created yet / rotates.
  const initialCommand = args.job.status === 'running' ? `tail -n +1 -F ${log}` : `cat ${log}`;
  addTab(
    buildTab({
      projectId: args.projectId,
      cwd: args.job.cwd ?? '~',
      shell: args.shell ?? 'default',
      initialCommand,
      label: `job: ${args.job.label || args.job.id.slice(0, 8)}`,
    }),
  );
}

interface OpenProjectTerminalArgs {
  projectId: string;
  cwd: string;
  shell?: TerminalShell;
}

/** Open a new terminal tab scoped to a project (cwd = project path). */
export function openProjectTerminal({
  projectId,
  cwd,
  shell = 'default',
}: OpenProjectTerminalArgs): void {
  const { addTab } = useTerminalStore.getState();
  addTab(buildTab({ projectId, cwd, shell }));
}

interface OpenThreadTerminalArgs {
  thread: Pick<Thread, 'id' | 'projectId' | 'isScratch' | 'worktreePath'>;
  shell?: TerminalShell;
}

/**
 * Open a new terminal tab for a thread. Resolves cwd from the thread's
 * worktree (worktree mode), falling back to the project path (local mode).
 * For scratch threads the tab is grouped under {@link SCRATCH_TERMINAL_SCOPE_ID}
 * and the runner derives the cwd from `scratchThreadId`.
 */
export function openThreadTerminal({ thread, shell = 'default' }: OpenThreadTerminalArgs): void {
  const { addTab } = useTerminalStore.getState();

  if (thread.isScratch) {
    addTab(
      buildTab({
        projectId: SCRATCH_TERMINAL_SCOPE_ID,
        cwd: '~',
        shell,
        scratchThreadId: thread.id,
      }),
    );
    return;
  }

  const projects = useProjectStore.getState().projects;
  const project = projects.find((p) => p.id === thread.projectId);
  const cwd = thread.worktreePath ?? project?.path ?? '~';
  addTab(buildTab({ projectId: thread.projectId, cwd, shell }));
}
