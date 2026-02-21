import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUIStore } from '@/stores/ui-store';
import { useWorkflowStore } from '@/stores/workflow-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';

const PIPELINE_AGENTS = [
  { value: 'tests', label: 'Tests' },
  { value: 'security', label: 'Security' },
  { value: 'architecture', label: 'Architecture' },
  { value: 'performance', label: 'Performance' },
  { value: 'style', label: 'Style' },
  { value: 'types', label: 'Types' },
  { value: 'docs', label: 'Docs' },
] as const;

export function WorkflowDialog() {
  const { t } = useTranslation();
  const projectId = useUIStore((s) => s.workflowDialogProjectId);
  const projectPath = useUIStore((s) => s.workflowDialogProjectPath);
  const projectName = useUIStore((s) => s.workflowDialogProjectName);
  const closeDialog = useUIStore((s) => s.closeWorkflowDialog);
  const triggerWorkflow = useWorkflowStore((s) => s.triggerWorkflow);

  const [branch, setBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState('main');
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['tests', 'security', 'style']);
  const [loading, setLoading] = useState(false);

  const open = !!projectId;

  // Load branches when dialog opens — filter to only this project's branches
  useEffect(() => {
    if (!projectId) return;
    api.listBranches(projectId).then((result) => {
      result.match(
        (data) => {
          // Common base branches that belong to every project
          const baseBranches = ['main', 'master', 'develop'];
          // Filter: show base branches + branches prefixed with this project's name
          const filtered = data.branches.filter((b: string) =>
            baseBranches.includes(b) ||
            (projectName && b.startsWith(`${projectName}/`)),
          );
          // If filtering removed everything, show all (project name might not match prefix)
          const finalBranches = filtered.length > 0 ? filtered : data.branches;
          setBranches(finalBranches);
          // Default to current branch if it's in the filtered list, otherwise first
          const current = data.currentBranch && finalBranches.includes(data.currentBranch)
            ? data.currentBranch
            : finalBranches[0] ?? '';
          setBranch(current);
          setBaseBranch(data.defaultBranch ?? 'main');
        },
        () => setBranches([]),
      );
    });
  }, [projectId, projectName]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setBranch('');
      setBaseBranch('main');
      setBranches([]);
      setSelectedAgents(['tests', 'security', 'style']);
    }
  }, [open]);

  const toggleAgent = (agent: string) => {
    setSelectedAgents((prev) =>
      prev.includes(agent) ? prev.filter((a) => a !== agent) : [...prev, agent],
    );
  };

  const handleRun = async () => {
    if (!projectId || !projectPath || !branch) return;

    setLoading(true);

    // Try direct pipeline run first (works without Hatchet)
    const result = await api.runPipeline({
      branch,
      worktree_path: projectPath,
      base_branch: baseBranch,
      config: selectedAgents.length > 0 ? { agents: selectedAgents } : undefined,
      metadata: { projectId },
    });

    setLoading(false);

    if (result.isOk()) {
      toast.success(`Pipeline started for branch "${branch}"`, {
        description: `Request ID: ${result.value.request_id}`,
      });
      closeDialog();
    } else {
      // Fallback: try Hatchet workflow
      setLoading(true);
      const runId = await triggerWorkflow('feature-to-deploy', {
        projectPath,
        branch,
        baseBranch,
      }, projectId);
      setLoading(false);

      if (runId) {
        toast.success('Workflow triggered via Hatchet');
        closeDialog();
      } else {
        toast.error('Failed to start pipeline', {
          description: result.error.message,
        });
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) closeDialog(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Run Quality Pipeline</DialogTitle>
          <DialogDescription>
            Run quality agents on a branch to check tests, security, style, and more.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Branch selector */}
          {branches.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Branch to analyze</label>
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger>
                  <SelectValue placeholder="Select branch..." />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Base branch */}
          {branches.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Base branch (compare against)</label>
              <Select value={baseBranch} onValueChange={setBaseBranch}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Show common base branches first, then the rest */}
                  {['main', 'master', 'develop'].filter((b) => branches.includes(b)).map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                  {branches.filter((b) => b !== 'main' && b !== 'master' && b !== 'develop').map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Agent selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Quality agents</label>
            <div className="flex flex-wrap gap-1.5">
              {PIPELINE_AGENTS.map((agent) => (
                <button
                  key={agent.value}
                  type="button"
                  onClick={() => toggleAgent(agent.value)}
                  className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                    selectedAgents.includes(agent.value)
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
                  }`}
                >
                  {agent.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeDialog}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={handleRun}
            disabled={!branch || selectedAgents.length === 0}
            loading={loading}
          >
            Run Pipeline
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
