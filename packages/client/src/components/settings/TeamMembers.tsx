import type { TeamRole } from '@funny/shared';
import { Copy, Check, Link, MailWarning, Send, Trash2, UserMinus, X } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
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

/** Better Auth org plugin only supports these roles for invitations */
type InviteRole = 'admin' | 'owner' | 'member';

interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
}

const INVITE_ROLES: { value: InviteRole; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
];

interface InviteLink {
  id: string;
  token: string;
  role: string;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  createdAt: string;
}

export function TeamMembers() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [removeConfirm, setRemoveConfirm] = useState<Member | null>(null);
  const currentUser = useAuthStore((s) => s.user);

  // Invitation state
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteRole>('member');
  const [sending, setSending] = useState(false);

  // SMTP config state
  const [smtpConfigured, setSmtpConfigured] = useState<boolean | null>(null);

  // Invite link state
  const [inviteLinks, setInviteLinks] = useState<InviteLink[]>([]);
  const [linkRole, setLinkRole] = useState<InviteRole>('member');
  const [creatingLink, setCreatingLink] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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

  const loadInvitations = useCallback(async () => {
    try {
      const res = await authClient.organization.listInvitations();
      if (res.data) {
        setInvitations(
          (res.data as unknown as PendingInvitation[]).filter((i) => i.status === 'pending'),
        );
      }
    } catch (err) {
      console.error('[TeamMembers] Failed to load invitations:', err);
    }
  }, []);

  const loadInviteLinks = useCallback(async () => {
    const result = await api.listInviteLinks();
    if (result.isOk()) {
      setInviteLinks(result.value);
    }
  }, []);

  const checkSmtpConfig = useCallback(async () => {
    const result = await api.getSmtpSettings();
    if (result.isOk()) {
      setSmtpConfigured(result.value.configured);
    } else {
      setSmtpConfigured(false);
    }
  }, []);

  useEffect(() => {
    loadMembers();
    loadInvitations();
    loadInviteLinks();
    checkSmtpConfig();
  }, [loadMembers, loadInvitations, loadInviteLinks, checkSmtpConfig]);

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

  const handleInvite = useCallback(async () => {
    if (!inviteEmail.trim()) return;
    setSending(true);
    try {
      await authClient.organization.inviteMember({
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      toast.success(`Invitation sent to ${inviteEmail.trim()}`);
      setInviteEmail('');
      await loadInvitations();
    } catch (err: any) {
      toast.error(err.message || 'Failed to send invitation');
    } finally {
      setSending(false);
    }
  }, [inviteEmail, inviteRole, loadInvitations]);

  const handleCreateLink = useCallback(async () => {
    setCreatingLink(true);
    try {
      const result = await api.createInviteLink({ role: linkRole, expiresInDays: 7 });
      if (result.isOk()) {
        setInviteLinks((prev) => [result.value, ...prev]);
        toast.success('Invite link created');
      } else {
        toast.error('Failed to create invite link');
      }
    } catch {
      toast.error('Failed to create invite link');
    } finally {
      setCreatingLink(false);
    }
  }, [linkRole]);

  const handleRevokeLink = useCallback(async (linkId: string) => {
    const result = await api.revokeInviteLink(linkId);
    if (result.isOk()) {
      setInviteLinks((prev) => prev.filter((l) => l.id !== linkId));
      toast.success('Invite link revoked');
    } else {
      toast.error('Failed to revoke invite link');
    }
  }, []);

  const handleCopyLink = useCallback((link: InviteLink) => {
    const url = `${window.location.origin}/invite/${link.token}`;
    navigator.clipboard.writeText(url);
    setCopiedId(link.id);
    toast.success('Link copied to clipboard');
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const handleCancelInvitation = useCallback(async (invitationId: string) => {
    try {
      await authClient.organization.cancelInvitation({ invitationId });
      setInvitations((prev) => prev.filter((i) => i.id !== invitationId));
      toast.success('Invitation cancelled');
    } catch (err: any) {
      toast.error(err.message || 'Failed to cancel invitation');
    }
  }, []);

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
      {/* Invite form */}
      <h3 className="settings-section-header">Invite Member</h3>
      <div className="settings-card">
        <div className="px-4 py-3.5">
          {smtpConfigured === false && (
            <div
              className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
              data-testid="team-invite-smtp-warning"
            >
              <MailWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Email is not configured. Configure SMTP in <strong>Settings &gt; Email</strong> to
                send invitations, or use an invite link below.
              </span>
            </div>
          )}
          <p className="mb-3 text-xs text-muted-foreground">
            Send an invitation to join this organization.
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="user@example.com"
              className="flex-1 text-sm"
              disabled={smtpConfigured === false}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && smtpConfigured) handleInvite();
              }}
              data-testid="team-invite-email"
            />
            <Select
              value={inviteRole}
              onValueChange={(v) => setInviteRole(v as InviteRole)}
              disabled={smtpConfigured === false}
            >
              <SelectTrigger className="h-9 w-[100px]" data-testid="team-invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVITE_ROLES.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={handleInvite}
              disabled={!inviteEmail.trim() || sending || smtpConfigured === false}
              data-testid="team-invite-send"
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              Invite
            </Button>
          </div>
        </div>
      </div>

      {/* Invite link */}
      <h3 className="settings-section-header">Invite Link</h3>
      <div className="settings-card">
        <div className="px-4 py-3.5">
          <p className="mb-3 text-xs text-muted-foreground">
            Generate a shareable link to invite people to this organization.
          </p>
          <div className="flex items-center gap-2">
            <Select value={linkRole} onValueChange={(v) => setLinkRole(v as InviteRole)}>
              <SelectTrigger className="h-9 w-[100px]" data-testid="team-link-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVITE_ROLES.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={handleCreateLink}
              disabled={creatingLink}
              data-testid="team-link-create"
            >
              <Link className="mr-1.5 h-3.5 w-3.5" />
              Generate Link
            </Button>
          </div>
          {inviteLinks.length > 0 && (
            <div className="mt-3 space-y-2">
              {inviteLinks.map((link) => {
                const isExpired = link.expiresAt && new Date(link.expiresAt) < new Date();
                const isMaxed = link.maxUses !== null && link.useCount >= link.maxUses;
                const isActive = !isExpired && !isMaxed;

                return (
                  <div
                    key={link.id}
                    className="flex items-center gap-2 rounded-md border border-border/50 px-3 py-2"
                    data-testid={`team-link-${link.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <code className="truncate text-xs text-muted-foreground">
                          {window.location.origin}/invite/{link.token}
                        </code>
                        <Badge
                          variant="secondary"
                          className={
                            isActive
                              ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                              : 'bg-red-500/15 text-red-700 dark:text-red-400'
                          }
                        >
                          {isExpired ? 'expired' : isMaxed ? 'maxed' : link.role}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {link.useCount} use{link.useCount !== 1 ? 's' : ''}
                        {link.expiresAt &&
                          ` · expires ${new Date(link.expiresAt).toLocaleDateString()}`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => handleCopyLink(link)}
                      disabled={!isActive}
                      data-testid={`team-link-copy-${link.id}`}
                    >
                      {copiedId === link.id ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRevokeLink(link.id)}
                      data-testid={`team-link-revoke-${link.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Members list */}
      <h3 className="settings-section-header">Members ({members.length})</h3>
      <div className="settings-card">
        {members.map((member) => {
          const isCurrentUser = member.userId === currentUser?.id;
          const isLastOwner = member.role === 'owner' && ownerCount <= 1;

          return (
            <div
              key={member.id}
              className="settings-row"
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

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <>
          <h3 className="settings-section-header">Pending Invitations ({invitations.length})</h3>
          <div className="settings-card">
            {invitations.map((inv) => (
              <div key={inv.id} className="settings-row" data-testid={`team-invitation-${inv.id}`}>
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">{inv.email}</p>
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{inv.role}</Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => handleCancelInvitation(inv.id)}
                    data-testid={`team-invitation-cancel-${inv.id}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

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
