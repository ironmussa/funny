import { formatCompactElapsed } from '@funny/client-core';
import type { ThreadStatus, GitSyncState, ThreadStage } from '@funny/shared';
import {
  Clock,
  Loader2,
  CircleStop,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  CircleDot,
  GitPullRequestArrow,
  GitMerge,
  LayoutList,
  Lightbulb,
  Play,
  Eye,
  Archive,
  WifiOff,
} from 'lucide-react';

import { GIT_CHANGES_ICON, GIT_UNPUSHED_ICON } from '@/lib/git-icons';
import type { RunnerStatus } from '@/stores/runner-status-store';

/**
 * Display status — superset of `ThreadStatus` plus client-only derived states.
 * `runner_offline` is rendered when the thread's DB status is `running`/
 * `setting_up` but the runner has dropped its connection; auto-resume on the
 * runtime side will pick it back up when the runner returns, so we keep the
 * DB row untouched and only swap the displayed icon/label.
 */
export type DisplayThreadStatus = ThreadStatus | 'runner_offline';

/**
 * A thread status glyph. `dotClassName` is the fill of the dot a theme may show
 * instead of the icon (Minimal does in the sidebar, see `.status-glyph-dots` in
 * globals.css); statuses without one always show their icon.
 */
export interface StatusGlyphConfig {
  icon: typeof Clock;
  className: string;
  dotClassName?: string;
}

export const statusConfig: Record<DisplayThreadStatus, StatusGlyphConfig> = {
  setting_up: {
    icon: Loader2,
    className: 'text-thread-icon-running animate-spin',
    dotClassName: 'bg-thread-dot-running status-glyph-blink',
  },
  idle: { icon: CircleDot, className: 'text-gray-400' },
  // A pending thread is always about to start (between worktree setup and the
  // agent's first `running` status), so it shares the running spinner instead
  // of flashing a different icon mid-launch.
  pending: {
    icon: Loader2,
    className: 'text-thread-icon-running animate-spin',
    dotClassName: 'bg-thread-dot-running status-glyph-blink',
  },
  running: {
    icon: Loader2,
    className: 'text-thread-icon-running animate-spin',
    dotClassName: 'bg-thread-dot-running status-glyph-blink',
  },
  waiting: { icon: Clock, className: 'text-thread-icon-waiting' },
  completed: {
    icon: CheckCircle2,
    className: 'text-thread-icon-completed',
    dotClassName: 'bg-thread-dot-completed',
  },
  failed: {
    icon: XCircle,
    className: 'text-thread-icon-failed',
    dotClassName: 'bg-thread-dot-failed',
  },
  stopped: { icon: CircleStop, className: 'text-thread-icon-failed' },
  interrupted: {
    icon: AlertTriangle,
    className: 'text-thread-icon-interrupted',
    dotClassName: 'bg-thread-dot-interrupted',
  },
  runner_offline: {
    icon: WifiOff,
    className: 'text-thread-icon-interrupted',
    dotClassName: 'bg-thread-dot-interrupted',
  },
};

/**
 * Compute the displayed status given the DB status + current runner liveness.
 * A `running`/`setting_up` thread on a disconnected runner shows as
 * `runner_offline` so the UI doesn't show a permanent spinner for a process
 * that isn't actually executing anymore.
 */
export function getDisplayThreadStatus(
  status: ThreadStatus,
  runnerStatus: RunnerStatus,
): DisplayThreadStatus {
  if (runnerStatus === 'offline' && (status === 'running' || status === 'setting_up')) {
    return 'runner_offline';
  }
  return status;
}

export const stageConfig: Record<
  ThreadStage,
  { icon: typeof Clock; className: string; labelKey: string }
> = {
  backlog: { icon: LayoutList, className: 'text-muted-foreground', labelKey: 'kanban.backlog' },
  planning: { icon: Lightbulb, className: 'text-muted-foreground', labelKey: 'kanban.planning' },
  in_progress: { icon: Play, className: 'text-muted-foreground', labelKey: 'kanban.inProgress' },
  review: { icon: Eye, className: 'text-muted-foreground', labelKey: 'kanban.review' },
  done: { icon: CheckCircle2, className: 'text-muted-foreground', labelKey: 'kanban.done' },
  archived: { icon: Archive, className: 'text-muted-foreground', labelKey: 'kanban.archived' },
};

export function timeAgo(
  dateStr: string | number,
  t: (key: string, opts?: any) => string,
  now = Date.now(),
): string {
  const ms = new Date(dateStr).getTime();
  if (isNaN(ms)) return String(dateStr);
  const seconds = Math.floor((now - ms) / 1000);
  if (seconds < 60) return t('time.now');
  return elapsedMinutesLabel(Math.floor(seconds / 60), t);
}

/** A whole number of elapsed minutes as minutes, hours, days or months. */
export function elapsedMinutesLabel(
  minutes: number,
  t: (key: string, opts?: any) => string,
): string {
  if (minutes < 60) return t('time.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hours', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('time.days', { count: days });
  return t('time.months', { count: Math.floor(days / 30) });
}

/** Derive a compact relative label from an absolute timestamp. */
export function shortTimeAgo(dateStr: string | number, now = Date.now()): string {
  const ms = new Date(dateStr).getTime();
  if (isNaN(ms)) return String(dateStr);
  return formatCompactElapsed(ms, now);
}

export const gitSyncStateConfig: Record<
  GitSyncState,
  { icon: typeof Clock; className: string; labelKey: string }
> = {
  dirty: {
    icon: GIT_CHANGES_ICON,
    className: 'text-muted-foreground',
    labelKey: 'gitStatus.dirty',
  },
  unpushed: {
    icon: GIT_UNPUSHED_ICON,
    className: 'text-git-icon-unpushed',
    labelKey: 'gitStatus.unpushed',
  },
  pushed: {
    icon: GitPullRequestArrow,
    className: 'text-git-icon-pushed',
    labelKey: 'gitStatus.pushed',
  },
  merged: { icon: GitMerge, className: 'text-git-icon-merged', labelKey: 'gitStatus.merged' },
  clean: { icon: CheckCircle2, className: 'text-muted-foreground', labelKey: 'gitStatus.clean' },
};

/** Map full model IDs (from Claude SDK / Gemini CLI) back to friendly keys used in translations. */
const MODEL_ID_TO_KEY = new Map<string, string>(
  Object.entries({
    'claude-opus-4-6': 'opus',
    'claude-opus-4-6[1m]': 'opus',
    'claude-opus-4-7': 'opus47',
    'claude-opus-4-7[1m]': 'opus47',
    'claude-opus-4-8': 'opus48',
    'claude-opus-4-8[1m]': 'opus48',
    'claude-opus-5': 'opus5',
    'claude-opus-5-5': 'opus55',
    'claude-mythos-5-2': 'mythos52',
    'claude-mythos-5-2[1m]': 'mythos52',
    'claude-fable-5-2': 'fable52',
    'claude-fable-5-2[1m]': 'fable52',
    'claude-fable-5-1': 'fable51',
    'claude-fable-5-1[1m]': 'fable51',
    'claude-fable-5': 'fable5',
    'claude-fable-5[1m]': 'fable5',
    'claude-sonnet-4-5-20250929': 'sonnet',
    'claude-sonnet-4-6': 'sonnet46',
    'claude-sonnet-4-6[1m]': 'sonnet46',
    'claude-haiku-4-5-20251001': 'haiku',
    'gemini-2.0-flash': 'gemini20flash',
    'gemini-2.5-flash': 'gemini25flash',
    'gemini-2.5-pro': 'gemini25pro',
    'gemini-3.1-pro-preview': 'gemini31pro',
    'gemini-3-flash-preview': 'gemini3flash',
    'gemini-3.1-flash-lite-preview': 'gemini31flashLite',
    // Legacy model IDs (threads created with previous IDs — fall back to current labels)
    'gemini-3-pro-preview': 'gemini31pro',
    'gemini-3.1-pro': 'gemini31pro',
    'gemini-3-flash': 'gemini3flash',
  } satisfies Record<string, string>),
);

export function resolveModelLabel(modelId: string, t: (key: string, opts?: any) => string): string {
  const key = MODEL_ID_TO_KEY.get(modelId) ?? modelId;
  return t(`thread.model.${key}`, { defaultValue: modelId });
}

export function getStatusLabels(t: (key: string) => string): Record<DisplayThreadStatus, string> {
  return {
    setting_up: t('thread.status.settingUp'),
    idle: t('thread.status.idle'),
    pending: t('thread.status.pending'),
    running: t('thread.status.running'),
    waiting: t('thread.status.waiting'),
    completed: t('thread.status.completed'),
    failed: t('thread.status.failed'),
    stopped: t('thread.status.stopped'),
    interrupted: t('thread.status.interrupted'),
    runner_offline: t('thread.status.runnerOffline'),
  };
}
