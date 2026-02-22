import {
  Clock,
  Loader2,
  CircleStop,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  CircleDot,
  ArrowUpCircle,
  GitPullRequestArrow,
  GitMerge,
  LayoutList,
  ClipboardList,
  Play,
  Eye,
  Archive,
} from 'lucide-react';
import type { ThreadStatus, GitSyncState, ThreadStage } from '@funny/shared';

export const statusConfig: Record<ThreadStatus, { icon: typeof Clock; className: string }> = {
  idle: { icon: CircleDot, className: 'text-gray-400' },
  pending: { icon: Clock, className: 'text-yellow-400' },
  running: { icon: Loader2, className: 'text-blue-400 animate-spin' },
  waiting: { icon: Clock, className: 'text-amber-400' },
  completed: { icon: CheckCircle2, className: 'text-green-400' },
  failed: { icon: XCircle, className: 'text-red-400' },
  stopped: { icon: CircleStop, className: 'text-gray-400' },
  interrupted: { icon: AlertTriangle, className: 'text-orange-400' },
};

export const stageConfig: Record<ThreadStage, { icon: typeof Clock; className: string; labelKey: string }> = {
  backlog: { icon: LayoutList, className: 'text-gray-400', labelKey: 'kanban.backlog' },
  planning: { icon: ClipboardList, className: 'text-violet-400', labelKey: 'kanban.planning' },
  in_progress: { icon: Play, className: 'text-blue-400', labelKey: 'kanban.inProgress' },
  review: { icon: Eye, className: 'text-amber-400', labelKey: 'kanban.review' },
  done: { icon: CheckCircle2, className: 'text-green-400', labelKey: 'kanban.done' },
  archived: { icon: Archive, className: 'text-gray-400', labelKey: 'kanban.archived' },
};

export function timeAgo(dateStr: string, t: (key: string, opts?: any) => string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return t('time.now');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hours', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('time.days', { count: days });
  return t('time.months', { count: Math.floor(days / 30) });
}

export const gitSyncStateConfig: Record<GitSyncState, { icon: typeof Clock; className: string; labelKey: string }> = {
  dirty:    { icon: CircleDot,            className: 'text-muted-foreground', labelKey: 'gitStatus.dirty' },
  unpushed: { icon: ArrowUpCircle,        className: 'text-muted-foreground', labelKey: 'gitStatus.unpushed' },
  pushed:   { icon: GitPullRequestArrow,  className: 'text-muted-foreground', labelKey: 'gitStatus.pushed' },
  merged:   { icon: GitMerge,             className: 'text-muted-foreground', labelKey: 'gitStatus.merged' },
  clean:    { icon: CheckCircle2,         className: 'text-muted-foreground', labelKey: 'gitStatus.clean' },
};

/** Map full model IDs (from Claude SDK / Gemini CLI) back to friendly keys used in translations. */
const MODEL_ID_TO_KEY: Record<string, string> = {
  'claude-opus-4-6': 'opus',
  'claude-sonnet-4-5-20250929': 'sonnet',
  'claude-sonnet-4-6': 'sonnet46',
  'claude-haiku-4-5-20251001': 'haiku',
  'gemini-2.0-flash': 'gemini20flash',
  'gemini-2.5-flash': 'gemini25flash',
  'gemini-2.5-pro': 'gemini25pro',
  'gemini-3-flash-preview': 'gemini3flash',
  'gemini-3-pro-preview': 'gemini3pro',
  // Legacy model IDs (threads created before rename)
  'gemini-3-flash': 'gemini3flash',
  'gemini-3.1-pro': 'gemini3pro',
};

export function resolveModelLabel(modelId: string, t: (key: string, opts?: any) => string): string {
  const key = MODEL_ID_TO_KEY[modelId] ?? modelId;
  return t(`thread.model.${key}`, { defaultValue: modelId });
}

export function getStatusLabels(t: (key: string) => string): Record<ThreadStatus, string> {
  return {
    idle: t('thread.status.idle'),
    pending: t('thread.status.pending'),
    running: t('thread.status.running'),
    waiting: t('thread.status.waiting'),
    completed: t('thread.status.completed'),
    failed: t('thread.status.failed'),
    stopped: t('thread.status.stopped'),
    interrupted: t('thread.status.interrupted'),
  };
}
