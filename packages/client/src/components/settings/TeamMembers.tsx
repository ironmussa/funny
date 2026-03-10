import type { TeamRole } from '@funny/shared';
import { UserMinus } from 'lucide-react';
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
import { authClient } from '@/lib/auth-client';
import { useAuthStore } from '@/stores/auth-store';

interface Member {
  id: string;
  userId: string;
  role: TeamRole;
  user: { name: string; email: string };
  createdAt: string;
}

const ROLE_OPTIONS: { value: TeamRole; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];

const ROLE_COLORS: Record<TeamRole, string> = {
  owner: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  admin: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  member: 'bg-green-500/15 text-green-700 dark:text-green-400',
  viewer: 'bg-gray-500/15 text-gray-700 dark:text-gray-400',
};

export function TeamMembers() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [removeConfirm, setRemoveConfirm] = useState<Member | null>(null);
  const currentUser = useAuthStore((s) => s.user);

  const loadMembers = useCallback(async () => {
    try {
      const res = await authClient.organization.listMembers();
      if (res.data) {
        setMembers(res.data as unknown as Member[]);
      }
    } catch (err) {
      console.error('[TeamMembers] Failed to load members:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  const handleRoleChange = useCallback(async (memberId: string, newRole: TeamRole) => {
    try {
      await authClient.organization.updateMemberRole({
        memberId,
        role: newRole,
      });
      setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, role: newRole } : m)));
      toast.success('Role updated');
    } catch (err: any) {
      toast.error(err.message || 'Failed to update role');
    }
  }, []);

  const handleRemove = useCallback(async () => {
    if (!removeConfirm) return;
    try {
      await authClient.organization.removeMember({
        memberIdOrEmail: removeConfirm.userId,
      });
      setMembers((prev) => prev.filter((m) => m.id !== removeConfirm.id));
      toast.success('Member removed');
    } catch (err: any) {
      toast.error(err.message || 'Failed to remove member');
    }
    setRemoveConfirm(null);
  }, [removeConfirm]);

  const ownerCount = members.filter((m) => m.role === 'owner').length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Loading members...
      </div>
    );
  }

  return (
    <>
      <h3 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Members ({members.length})
      </h3>
      <div className="overflow-hidden rounded-lg border border-border/50">
        {members.map((member) => {
          const isCurrentUser = member.userId === currentUser?.id;
          const isLastOwner = member.role === 'owner' && ownerCount <= 1;

          return (
            <div
              key={member.id}
              className="flex items-center justify-between gap-4 border-b border-border/50 px-4 py-3 last:border-b-0"
              data-testid={`team-member-${member.userId}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-foreground">
                    {member.user.name}
                    {isCurrentUser && (
                      <span className="ml-1 text-xs text-muted-foreground">(you)</span>
                    )}
                  </p>
                  <Badge
                    variant="secondary"
                    className={ROLE_COLORS[member.role]}
                    data-testid={`team-member-role-badge-${member.userId}`}
                  >
                    {member.role}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{member.user.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={member.role}
                  onValueChange={(v) => handleRoleChange(member.id, v as TeamRole)}
                  disabled={isLastOwner && member.role === 'owner'}
                >
                  <SelectTrigger
                    className="h-8 w-[100px]"
                    data-testid={`team-member-role-select-${member.userId}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => setRemoveConfirm(member)}
                  disabled={isLastOwner}
                  data-testid={`team-member-remove-${member.userId}`}
                >
                  <UserMinus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={!!removeConfirm}
        onOpenChange={(open) => {
          if (!open) setRemoveConfirm(null);
        }}
        title="Remove Member"
        description={`Remove ${removeConfirm?.user.name} from this organization? They will lose access to all team projects.`}
        cancelLabel="Cancel"
        confirmLabel="Remove"
        onCancel={() => setRemoveConfirm(null)}
        onConfirm={handleRemove}
      />
    </>
  );
}
