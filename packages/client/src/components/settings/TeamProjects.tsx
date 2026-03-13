import type { Project } from '@funny/shared';
import { FolderKanban, Trash2 } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';

export function TeamProjects() {
  const [teamProjects, setTeamProjects] = useState<Project[]>([]);
  const [userProjects, setUserProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [teamResult, userResult] = await Promise.all([
      api.listTeamProjects(),
      api.listProjects(),
    ]);
    if (teamResult.isOk()) setTeamProjects(teamResult.value);
    else toast.error('Failed to load team projects');
    if (userResult.isOk()) setUserProjects(userResult.value);
    else toast.error('Failed to load projects');
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const teamProjectIds = new Set(teamProjects.map((p) => p.id));
  const availableProjects = userProjects.filter((p) => !teamProjectIds.has(p.id));

  const handleAdd = async () => {
    if (!selectedProjectId) return;
    const result = await api.addTeamProject(selectedProjectId);
    if (result.isOk()) {
      toast.success('Project shared with team');
      setSelectedProjectId('');
      refresh();
    } else {
      toast.error('Failed to share project');
    }
  };

  const handleRemove = async (projectId: string) => {
    setRemoving(null);
    const result = await api.removeTeamProject(projectId);
    if (result.isOk()) {
      toast.success('Project removed from team');
      refresh();
    } else {
      toast.error('Failed to remove project');
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Add project section */}
      <div>
        <h3 className="settings-section-header">Share a Project</h3>
        <div className="settings-card">
          <div className="flex items-center gap-2">
            <Select
              value={selectedProjectId}
              onValueChange={setSelectedProjectId}
              disabled={availableProjects.length === 0}
            >
              <SelectTrigger className="flex-1" data-testid="team-project-add-select">
                <SelectValue
                  placeholder={
                    availableProjects.length === 0
                      ? 'All projects are shared'
                      : 'Select a project...'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {availableProjects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={handleAdd}
              disabled={!selectedProjectId}
              size="sm"
              data-testid="team-project-add-btn"
            >
              <FolderKanban className="h-4 w-4 mr-1" />
              Share
            </Button>
          </div>
        </div>
      </div>

      {/* Shared projects list */}
      <div>
        <h3 className="settings-section-header">
          Shared Projects
          {teamProjects.length > 0 && (
            <Badge variant="secondary" className="ml-2">
              {teamProjects.length}
            </Badge>
          )}
        </h3>
        <div className="settings-card divide-y divide-border">
          {teamProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground py-3 px-4">
              No projects shared with the team yet. Use the dropdown above to share one.
            </p>
          ) : (
            teamProjects.map((project) => (
              <div
                key={project.id}
                className="settings-row"
                data-testid={`team-project-${project.id}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {project.color && (
                    <div
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                  )}
                  <span className="text-sm font-medium truncate">{project.name}</span>
                  <span className="text-xs text-muted-foreground truncate">{project.path}</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setRemoving(project.id)}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                  data-testid={`team-project-remove-${project.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove from team?"
        description="Team members will lose access to this project. The project itself is not deleted."
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) handleRemove(removing);
        }}
        data-testid="team-project-remove-confirm"
      />
    </div>
  );
}
