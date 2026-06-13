/**
 * RunnersSettings — lets users connect and manage their own remote runners.
 *
 * Users copy a generated install command, run it on any machine, and the runner
 * connects to the server under their account. No admin involvement needed.
 */

import type { RunnerInfo, RunnerProjectAssignment } from '@funny/shared/runner-protocol';
import {
  ChevronDown,
  ChevronRight,
  Circle,
  FolderPlus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ConnectRunnerCard } from '@/components/ConnectRunnerCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

function statusColor(status: RunnerInfo['status']) {
  if (status === 'online') return 'text-green-500';
  if (status === 'busy') return 'text-yellow-500';
  return 'text-muted-foreground';
}

function statusLabel(status: RunnerInfo['status']) {
  if (status === 'online') return 'Online';
  if (status === 'busy') return 'Busy';
  return 'Offline';
}

function osEmoji(os: string) {
  if (os === 'darwin') return '🍎';
  if (os === 'win32') return '🪟';
  return '🐧';
}

function formatRelativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface AssignFormProps {
  runnerId: string;
  onAssigned: () => void;
}

function AssignProjectForm({ runnerId, onAssigned }: AssignFormProps) {
  const projects = useAppStore((s) => s.projects);
  const [projectId, setProjectId] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAssign = async () => {
    if (!projectId || !localPath.trim()) return;
    setSaving(true);
    const result = await api.assignRunnerProject(runnerId, projectId, localPath.trim());
    setSaving(false);
    if (result.isOk()) {
      toast.success('Project assigned');
      setProjectId('');
      setLocalPath('');
      onAssigned();
    } else {
      toast.error('Failed to assign project');
    }
  };

  return (
    <div className="border-border/50 bg-muted/30 mt-3 flex flex-col gap-2 rounded border p-3">
      <p className="text-muted-foreground text-sm">
        Assign a project and provide its local path on this runner's machine.
      </p>
      <Select value={projectId} onValueChange={setProjectId}>
        <SelectTrigger size="xs" data-testid={`runner-assign-project-select-${runnerId}`}>
          <SelectValue placeholder="Select project..." />
        </SelectTrigger>
        <SelectContent>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        value={localPath}
        onChange={(e) => setLocalPath(e.target.value)}
        placeholder="/home/user/my-project"
        className="h-7 font-mono text-xs"
        data-testid={`runner-assign-localpath-${runnerId}`}
      />
      <Button
        size="sm"
        className="h-6 text-xs"
        disabled={!projectId || !localPath.trim() || saving}
        onClick={handleAssign}
        data-testid={`runner-assign-submit-${runnerId}`}
      >
        {saving ? 'Assigning...' : 'Assign'}
      </Button>
    </div>
  );
}

interface RunnerCardProps {
  runner: RunnerInfo;
  onDeleted: () => void;
}

function RunnerCard({ runner, onDeleted }: RunnerCardProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [assignments, setAssignments] = useState<RunnerProjectAssignment[]>([]);
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadAssignments = async () => {
    // Fetch from the runner's projects list — reuse existing API
    const result = await api.getMyRunners();
    if (result.isOk()) {
      const r = result.value.runners.find((x) => x.runnerId === runner.runnerId);
      if (r) {
        // Assignments are by projectId, we just have the IDs
        setAssignments(
          r.assignedProjectIds.map((pid) => ({
            runnerId: runner.runnerId,
            projectId: pid,
            localPath: '',
            assignedAt: '',
          })),
        );
      }
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    const result = await api.deleteRunner(runner.runnerId);
    setDeleting(false);
    if (result.isOk()) {
      setConfirmDelete(false);
      toast.success('Runner removed');
      onDeleted();
    } else {
      toast.error('Failed to remove runner');
    }
  };

  const handleUnassign = async (projectId: string) => {
    const result = await api.unassignRunnerProject(runner.runnerId, projectId);
    if (result.isOk()) {
      toast.success('Project unassigned');
      loadAssignments();
    } else {
      toast.error('Failed to unassign project');
    }
  };

  useEffect(() => {
    if (open) loadAssignments();
  }, [open]);

  const projects = useAppStore((s) => s.projects);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-border/50 bg-card overflow-hidden rounded-lg border"
    >
      <div
        className="flex items-center gap-3 px-3 py-2.5"
        data-testid={`runner-item-${runner.runnerId}`}
      >
        {/* Status dot */}
        <Circle className={cn('size-2 shrink-0 fill-current', statusColor(runner.status))} />

        {/* Name + meta */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{runner.name}</span>
            <span className="text-xs">{osEmoji(runner.os)}</span>
            <Badge
              variant="outline"
              className={cn('h-4 px-1.5 text-[10px]', statusColor(runner.status))}
            >
              {statusLabel(runner.status)}
            </Badge>
          </div>
          <div className="text-muted-foreground truncate text-xs">
            {runner.hostname} · last seen {formatRelativeTime(runner.lastHeartbeatAt)}
            {runner.assignedProjectIds.length > 0 && (
              <>
                {' '}
                · {runner.assignedProjectIds.length} project
                {runner.assignedProjectIds.length !== 1 ? 's' : ''}
              </>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  data-testid={`runner-item-${runner.runnerId}-expand`}
                >
                  {open ? (
                    <ChevronDown className="icon-sm" />
                  ) : (
                    <ChevronRight className="icon-sm" />
                  )}
                </Button>
              </CollapsibleTrigger>
            </TooltipTrigger>
            <TooltipContent>{open ? t('common.collapse') : t('common.expand')}</TooltipContent>
          </Tooltip>
          <TooltipIconButton
            size="icon"
            className="text-destructive hover:text-destructive size-6"
            onClick={() => setConfirmDelete(true)}
            disabled={deleting}
            data-testid={`runner-item-${runner.runnerId}-delete`}
            tooltip={t('common.delete')}
          >
            <Trash2 className="icon-sm" />
          </TooltipIconButton>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Remove runner"
        description={`Are you sure you want to remove "${runner.name}"? This action cannot be undone.`}
        confirmLabel={t('common.remove', 'Remove')}
        loading={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
      />

      <CollapsibleContent className="px-3 pb-3">
        <div className="mt-2 space-y-1">
          {assignments.length === 0 ? (
            <p className="text-muted-foreground text-xs">No projects assigned yet.</p>
          ) : (
            assignments.map((a) => {
              const project = projects.find((p) => p.id === a.projectId);
              return (
                <div
                  key={a.projectId}
                  className="hover:bg-muted/40 flex items-center justify-between rounded px-2 py-1 text-xs"
                >
                  <span className="truncate">{project?.name ?? a.projectId}</span>
                  <TooltipIconButton
                    size="icon"
                    className="text-destructive hover:text-destructive size-5"
                    onClick={() => handleUnassign(a.projectId)}
                    data-testid={`runner-item-${runner.runnerId}-unassign-${a.projectId}`}
                    tooltip={t('common.unassign')}
                  >
                    <Trash2 className="icon-xs" />
                  </TooltipIconButton>
                </div>
              );
            })
          )}

          <button
            className="text-primary mt-1 flex items-center gap-1 text-xs hover:underline"
            onClick={() => setShowAssignForm((v) => !v)}
            data-testid={`runner-item-${runner.runnerId}-add-project`}
          >
            <FolderPlus className="icon-sm" />
            Assign a project
          </button>
          {showAssignForm && (
            <AssignProjectForm
              runnerId={runner.runnerId}
              onAssigned={() => {
                setShowAssignForm(false);
                loadAssignments();
              }}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function RunnersSettings() {
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [loadingRunners, setLoadingRunners] = useState(true);

  const loadRunners = async () => {
    setLoadingRunners(true);
    const result = await api.getMyRunners();
    setLoadingRunners(false);
    if (result.isOk()) setRunners(result.value.runners);
  };

  useEffect(() => {
    loadRunners();

    // Refresh runner statuses every 30s
    const interval = setInterval(loadRunners, 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      {/* Install command (shared with the onboarding banner) */}
      <div className="settings-card space-y-3 p-4">
        <div>
          <p className="text-sm font-medium">Connect a new runner</p>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Run this command on any machine you want to use as a runner. It will connect to this
            server under your account.
          </p>
        </div>
        <ConnectRunnerCard />
      </div>

      {/* My runners list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">My Runners</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={loadRunners}
            disabled={loadingRunners}
            className="h-6 text-xs"
            data-testid="runners-refresh"
          >
            <RefreshCw className={cn('mr-1 icon-xs', loadingRunners && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {loadingRunners && runners.length === 0 ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : runners.length === 0 ? (
          <div className="border-border/50 rounded-lg border border-dashed px-4 py-6 text-center">
            <Server className="text-muted-foreground/50 mx-auto mb-2 size-8" />
            <p className="text-muted-foreground text-sm">No runners connected yet.</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Copy the install command above and run it on any machine.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {runners.map((r) => (
              <RunnerCard key={r.runnerId} runner={r} onDeleted={loadRunners} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
