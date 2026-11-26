import { Activity, FolderTree, GitCompare, type LucideIcon, MessageSquare } from 'lucide-react';

/**
 * The tool panels: every panel that opens beside the thread is declared here
 * once (openspec `tool-panels`). The rail, `?panel=`, the keyboard shortcuts
 * and the layout read this list; none of them lists panels on its own.
 *
 * Plain data on purpose: no React state and no store import, so tests and
 * non-React code can read it.
 */

/** Where a panel opens. `bottom` joins when the terminal becomes a registry entry. */
export type ToolPanelLocation = 'right';

export type RightPanelId = 'review' | 'files' | 'comments' | 'activity';
export type ToolPanelId = RightPanelId;

/** What a panel's availability depends on, for the open thread or project. */
export interface ToolPanelContext {
  /** A thread is open (or selected in the grid). */
  hasThread: boolean;
  /** The thread's project, or the selected project when no thread is open. */
  projectId: string | null;
  /** `isScratch` from thread-variant: a projectless thread. */
  scratch: boolean;
  /** `canDoGitOps`, and the user may see git on a read-only share. */
  canShowGit: boolean;
  /** `canShowComments` for the open thread. */
  canShowComments: boolean;
}

export interface ToolPanelDef {
  id: ToolPanelId;
  location: ToolPanelLocation;
  icon: LucideIcon;
  /** i18n key of the title, and its English fallback. */
  titleKey: string;
  titleFallback: string;
  /** Alt+<key> toggles the panel; lower case. */
  altKey?: string;
  /** `?panel=<id>` opens it. */
  urlParam: boolean;
  isAvailable: (ctx: ToolPanelContext) => boolean;
}

export const TOOL_PANELS: readonly ToolPanelDef[] = [
  {
    id: 'review',
    location: 'right',
    icon: GitCompare,
    titleKey: 'review.title',
    titleFallback: 'Review',
    altKey: 'g',
    urlParam: true,
    // A thread with git, or a project with no thread open (compose mode).
    isAvailable: (ctx) => ctx.canShowGit || (!ctx.hasThread && !!ctx.projectId && !ctx.scratch),
  },
  {
    id: 'files',
    location: 'right',
    icon: FolderTree,
    titleKey: 'projectFiles.title',
    titleFallback: 'Project Files',
    altKey: 'f',
    urlParam: true,
    isAvailable: (ctx) => !ctx.scratch && !!ctx.projectId,
  },
  {
    id: 'comments',
    location: 'right',
    icon: MessageSquare,
    titleKey: 'comments.title',
    titleFallback: 'Comments',
    altKey: 'm',
    urlParam: true,
    isAvailable: (ctx) => ctx.hasThread && ctx.canShowComments,
  },
  {
    id: 'activity',
    location: 'right',
    icon: Activity,
    titleKey: 'activity.title',
    titleFallback: 'Activity',
    urlParam: true,
    isAvailable: () => true,
  },
];

const BY_ID = new Map(TOOL_PANELS.map((p) => [p.id, p]));

/** The panel with this id, or undefined for an unknown id (e.g. from a URL). */
export function findToolPanel(id: string | null | undefined): ToolPanelDef | undefined {
  // SAFETY: a lookup miss is the answer for any string that is not an id.
  return id ? BY_ID.get(id as ToolPanelId) : undefined;
}

export function isRightToolPanelId(id: string | null | undefined): id is RightPanelId {
  return findToolPanel(id)?.location === 'right';
}
