/**
 * ProjectCollaborators — the project-scoped "who has access" page.
 *
 * Primary surface of the collaborator model: a project admin (owner or `admin`
 * member) adds existing user accounts directly to THIS project. No org and no
 * active-org context needed — access is per-project. (Org membership remains an
 * optional, separate bulk-access path managed under global preferences.)
 */

import { Search, Trash2, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import type { ProjectMemberEntry, ProjectMemberRole, UserSearchResult } from '@/lib/api/projects';
import { createClientLogger } from '@/lib/client-logger';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';

const log = createClientLogger('project-collaborators');

const ROLE_COLORS: Record<string, string> = {
  owner: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
  admin: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  member: 'bg-green-500/15 text-green-700 dark:text-green-400',
  viewer: 'bg-muted text-muted-foreground',
};

/** Assignable project roles (owner is the creator, not assignable here). */
const PROJECT_ROLES: { value: ProjectMemberRole; label: string; hint: string }[] = [
  { value: 'viewer', label: 'Viewer', hint: 'Read-only access to the project.' },
  { value: 'member', label: 'Member', hint: 'Work in the project and run threads.' },
  { value: 'admin', label: 'Admin', hint: 'Manage collaborators and project settings.' },
];

export function ProjectCollaborators() {
  const projectId = useProjectStore((s) => s.selectedProjectId);
  const ownerId = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.selectedProjectId)?.userId,
  );
  const currentUserId = useAuthStore((s) => s.user?.id);

  const [members, setMembers] = useState<ProjectMemberEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  // Role applied to the NEXT collaborator added.
  const [addRole, setAddRole] = useState<ProjectMemberRole>('member');
  const searchSeq = useRef(0);

  const loadMembers = useCallback(async () => {
    if (!projectId) return;
    const result = await api.listProjectMembers(projectId);
    if (result.isOk()) setMembers(result.value.members);
    else log.warn('Failed to load project members');
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  // Debounced user search.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const handle = setTimeout(async () => {
      const result = await api.searchUsers(q);
      if (seq !== searchSeq.current) return; // a newer search superseded this one
      if (result.isOk()) setResults(result.value);
      setSearching(false);
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  const memberIds = new Set(members.map((m) => m.userId));

  const handleAdd = useCallback(
    async (u: UserSearchResult) => {
      if (!projectId) return;
      const result = await api.addProjectMember(projectId, u.id, addRole);
      if (result.isOk()) {
        toast.success(`Added ${u.username ?? u.name} as ${addRole}`);
        setQuery('');
        setResults([]);
        loadMembers();
      } else {
        toast.error('Failed to add collaborator');
      }
    },
    [projectId, addRole, loadMembers],
  );

  // Re-role an existing collaborator (addProjectMember upserts on the server).
  const handleChangeRole = useCallback(
    async (m: ProjectMemberEntry, role: ProjectMemberRole) => {
      if (!projectId || m.role === role) return;
      const result = await api.addProjectMember(projectId, m.userId, role);
      if (result.isOk()) {
        toast.success('Role updated');
        loadMembers();
      } else {
        toast.error('Failed to update role');
      }
    },
    [projectId, loadMembers],
  );

  const handleRemove = useCallback(
    async (m: ProjectMemberEntry) => {
      if (!projectId) return;
      const result = await api.removeProjectMember(projectId, m.userId);
      if (result.isOk()) {
        toast.success('Collaborator removed');
        loadMembers();
      } else {
        toast.error('Failed to remove collaborator');
      }
    },
    [projectId, loadMembers],
  );

  if (loading) {
    return <LoadingState testId="collaborators-loading" label="Loading collaborators…" />;
  }

  return (
    <div className="space-y-4">
      <div className="px-1">
        <p className="text-muted-foreground mt-0.5 text-sm">
          People with access to this project. Each collaborator works through their own runner —
          they’ll be prompted to connect one and set their local directory.
        </p>
      </div>

      {/* Add collaborator */}
      <div className="settings-card space-y-2 p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search users by name, username or email…"
              className="pl-8 text-sm"
              data-testid="collaborators-search"
            />
          </div>
          {/* Role applied to the next collaborator added. */}
          <Select value={addRole} onValueChange={(v) => setAddRole(v as ProjectMemberRole)}>
            <SelectTrigger className="w-32 shrink-0" data-testid="collaborators-role-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROJECT_ROLES.map((r) => (
                <SelectItem
                  key={r.value}
                  value={r.value}
                  data-testid={`collaborators-role-opt-${r.value}`}
                >
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-muted-foreground text-[11px]">
          {PROJECT_ROLES.find((r) => r.value === addRole)?.hint}
        </p>

        {query.trim().length > 0 && (
          <div className="border-border/50 divide-border/50 divide-y rounded-md border">
            {searching && results.length === 0 ? (
              <p className="text-muted-foreground px-3 py-2 text-xs">Searching…</p>
            ) : results.length === 0 ? (
              <p className="text-muted-foreground px-3 py-2 text-xs">No users found.</p>
            ) : (
              results.map((u) => {
                const already = memberIds.has(u.id);
                return (
                  <div
                    key={u.id}
                    className="flex items-center justify-between px-3 py-2"
                    data-testid={`collaborators-result-${u.id}`}
                  >
                    <div className="min-w-0">
                      <p className="text-foreground truncate text-sm">{u.name || u.username}</p>
                      <p className="text-muted-foreground truncate text-xs">
                        @{u.username ?? u.email}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 text-xs"
                      disabled={already}
                      onClick={() => handleAdd(u)}
                      data-testid={`collaborators-add-${u.id}`}
                    >
                      <UserPlus className="icon-xs mr-1" />
                      {already ? 'Added' : 'Add'}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Member list */}
      <div className="settings-card divide-border/50 divide-y">
        {members.length === 0 ? (
          <p className="text-muted-foreground px-4 py-6 text-center text-sm">
            No collaborators yet.
          </p>
        ) : (
          members.map((m) => {
            const isOwner = m.userId === ownerId;
            const isSelf = m.userId === currentUserId;
            const label = m.user?.name || m.user?.username || m.userId;
            return (
              <div
                key={m.userId}
                className="flex items-center justify-between px-4 py-2.5"
                data-testid={`collaborators-member-${m.userId}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-foreground truncate text-sm font-medium">
                      {label}
                      {isSelf && <span className="text-muted-foreground ml-1 text-xs">(you)</span>}
                    </p>
                    {isOwner || isSelf ? (
                      <Badge
                        variant="secondary"
                        className={ROLE_COLORS[isOwner ? 'owner' : m.role] ?? ''}
                      >
                        {isOwner ? 'owner' : m.role}
                      </Badge>
                    ) : (
                      <Select
                        value={
                          (['viewer', 'member', 'admin'] as string[]).includes(m.role)
                            ? m.role
                            : 'member'
                        }
                        onValueChange={(v) => void handleChangeRole(m, v as ProjectMemberRole)}
                      >
                        <SelectTrigger
                          className="h-6 w-24 text-xs"
                          data-testid={`collaborators-role-${m.userId}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PROJECT_ROLES.map((r) => (
                            <SelectItem key={r.value} value={r.value} className="text-xs">
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {!m.localPath && !isOwner && (
                      <Badge
                        variant="secondary"
                        className="bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      >
                        needs setup
                      </Badge>
                    )}
                  </div>
                  {m.user?.username && (
                    <p className="text-muted-foreground truncate text-xs">@{m.user.username}</p>
                  )}
                </div>
                {/* The owner always retains access (projects.userId); don't offer
                    to strip their row. Members can't remove themselves here. */}
                {!isOwner && !isSelf && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive size-7 shrink-0"
                    onClick={() => handleRemove(m)}
                    data-testid={`collaborators-remove-${m.userId}`}
                    aria-label="Remove collaborator"
                  >
                    <Trash2 className="icon-sm" />
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
