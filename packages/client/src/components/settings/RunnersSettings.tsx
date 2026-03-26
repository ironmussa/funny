/**
 * RunnersSettings — lets users connect and manage their own remote runners.
 *
 * Users copy a generated install command, run it on any machine, and the runner
 * connects to the server under their account. No admin involvement needed.
 */

import type { RunnerInfo, RunnerProjectAssignment } from '@funny/shared/runner-protocol';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  FolderPlus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

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
    <div className="mt-3 flex flex-col gap-2 rounded border border-border/50 bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">
        Assign a project and provide its local path on this runner's machine.
      </p>
      <Select value={projectId} onValueChange={setProjectId}>
        <SelectTrigger
          className="h-7 text-xs"
          data-testid={`runner-assign-project-select-${runnerId}`}
        >
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
    if (!confirm(`Remove runner "${runner.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    const result = await api.deleteRunner(runner.runnerId);
    setDeleting(false);
    if (result.isOk()) {
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
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className="flex items-center gap-3 rounded-lg border border-border/50 bg-card px-3 py-2.5"
        data-testid={`runner-item-${runner.runnerId}`}
      >
        {/* Status dot */}
        <Circle className={cn('h-2 w-2 shrink-0 fill-current', statusColor(runner.status))} />

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
          <div className="truncate text-xs text-muted-foreground">
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
                  className="h-6 w-6"
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
            className="h-6 w-6 text-destructive hover:text-destructive"
            onClick={handleDelete}
            disabled={deleting}
            data-testid={`runner-item-${runner.runnerId}-delete`}
            tooltip={t('common.delete')}
          >
            <Trash2 className="icon-sm" />
          </TooltipIconButton>
        </div>
      </div>

      <CollapsibleContent className="px-3 pb-3">
        <div className="mt-2 space-y-1">
          {assignments.length === 0 ? (
            <p className="text-xs text-muted-foreground">No projects assigned yet.</p>
          ) : (
            assignments.map((a) => {
              const project = projects.find((p) => p.id === a.projectId);
              return (
                <div
                  key={a.projectId}
                  className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-muted/40"
                >
                  <span className="truncate">{project?.name ?? a.projectId}</span>
                  <TooltipIconButton
                    size="icon"
                    className="h-5 w-5 text-destructive hover:text-destructive"
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
            className="mt-1 flex items-center gap-1 text-xs text-primary hover:underline"
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
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [loadingToken, setLoadingToken] = useState(true);
  const [loadingRunners, setLoadingRunners] = useState(true);

  const serverUrl = window.location.origin;

  const installCommand = inviteToken ? `bunx funny --team ${serverUrl} --token ${inviteToken}` : '';

  const loadToken = async () => {
    setLoadingToken(true);
    const result = await api.getRunnerInviteToken();
    setLoadingToken(false);
    if (result.isOk()) setInviteToken(result.value.token);
  };

  const loadRunners = async () => {
    setLoadingRunners(true);
    const result = await api.getMyRunners();
    setLoadingRunners(false);
    if (result.isOk()) setRunners(result.value.runners);
  };

  useEffect(() => {
    loadToken();
    loadRunners();

    // Refresh runner statuses every 30s
    const interval = setInterval(loadRunners, 30_000);
    return () => clearInterval(interval);
  }, []);

  const handleCopy = () => {
    if (!installCommand) return;
    navigator.clipboard.writeText(installCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success('Command copied');
  };

  const handleRotate = async () => {
    if (
      !confirm(
        'Rotate the invite token? Existing connected runners are unaffected, but the old token cannot be used to register new runners.',
      )
    )
      return;
    setRotating(true);
    const result = await api.rotateRunnerInviteToken();
    setRotating(false);
    if (result.isOk()) {
      setInviteToken(result.value.token);
      toast.success('Token rotated');
    } else {
      toast.error('Failed to rotate token');
    }
  };

  return (
    <div className="space-y-6">
      <h3 className="settings-section-header">Runners</h3>

      {/* Install command */}
      <div className="settings-card space-y-3">
        <div>
          <p className="text-sm font-medium">Connect a new runner</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Run this command on any machine you want to use as a runner. It will connect to this
            server under your account.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <code
            className="flex-1 truncate rounded bg-muted px-3 py-2 font-mono text-xs text-foreground"
            data-testid="runners-install-command"
          >
            {loadingToken ? 'Loading...' : installCommand}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={handleCopy}
            disabled={loadingToken || !inviteToken}
            className="h-8 shrink-0"
            data-testid="runners-copy-command"
          >
            {copied ? <Check className="icon-sm" /> : <Copy className="icon-sm" />}
          </Button>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            <Server className="icon-xs mr-1 inline" />
            The token is specific to your account. Anyone with this token can register a runner
            under your name.
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleRotate}
            disabled={rotating || loadingToken}
            className="h-6 text-xs text-muted-foreground hover:text-foreground"
            data-testid="runners-rotate-token"
          >
            <RefreshCw className={cn('mr-1 icon-xs', rotating && 'animate-spin')} />
            Rotate token
          </Button>
        </div>
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
          <p className="text-xs text-muted-foreground">Loading...</p>
        ) : runners.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/50 px-4 py-6 text-center">
            <Server className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No runners connected yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
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
