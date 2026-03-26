import { Send, X } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

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
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { authClient } from '@/lib/auth-client';

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

export function TeamInvitations() {
  const { t } = useTranslation();
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [sending, setSending] = useState(false);

  const loadInvitations = useCallback(async () => {
    try {
      const res = await authClient.organization.listInvitations();
      if (res.data) {
        setInvitations(
          (res.data as unknown as PendingInvitation[]).filter((i) => i.status === 'pending'),
        );
      }
    } catch (err) {
      console.error('[TeamInvitations] Failed to load invitations:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvitations();
  }, [loadInvitations]);

  const handleInvite = useCallback(async () => {
    if (!email.trim()) return;
    setSending(true);
    try {
      await authClient.organization.inviteMember({
        email: email.trim(),
        role,
      });
      toast.success(`Invitation sent to ${email.trim()}`);
      setEmail('');
      await loadInvitations();
    } catch (err: any) {
      toast.error(err.message || 'Failed to send invitation');
    } finally {
      setSending(false);
    }
  }, [email, role, loadInvitations]);

  const handleCancel = useCallback(async (invitationId: string) => {
    try {
      await authClient.organization.cancelInvitation({ invitationId });
      setInvitations((prev) => prev.filter((i) => i.id !== invitationId));
      toast.success('Invitation cancelled');
    } catch (err: any) {
      toast.error(err.message || 'Failed to cancel invitation');
    }
  }, []);

  return (
    <>
      {/* Invite form */}
      <h3 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Invite Member
      </h3>
      <div className="mb-6 overflow-hidden rounded-lg border border-border/50">
        <div className="px-4 py-3.5">
          <p className="mb-3 text-xs text-muted-foreground">
            Send an invitation to join this organization.
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="flex-1 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleInvite();
              }}
              data-testid="team-invite-email"
            />
            <Select value={role} onValueChange={(v) => setRole(v as InviteRole)}>
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
              disabled={!email.trim() || sending}
              data-testid="team-invite-send"
            >
              <Send className="icon-sm mr-1.5" />
              Invite
            </Button>
          </div>
        </div>
      </div>

      {/* Pending invitations */}
      <h3 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Pending Invitations{!loading && invitations.length > 0 && ` (${invitations.length})`}
      </h3>
      <div className="overflow-hidden rounded-lg border border-border/50">
        {loading ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">Loading...</div>
        ) : invitations.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            No pending invitations
          </div>
        ) : (
          invitations.map((inv) => (
            <div
              key={inv.id}
              className="flex items-center justify-between gap-4 border-b border-border/50 px-4 py-3 last:border-b-0"
              data-testid={`team-invitation-${inv.id}`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{inv.email}</p>
                <p className="text-xs text-muted-foreground">
                  Expires {new Date(inv.expiresAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{inv.role}</Badge>
                <TooltipIconButton
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => handleCancel(inv.id)}
                  data-testid={`team-invitation-cancel-${inv.id}`}
                  tooltip={t('common.cancel')}
                >
                  <X className="icon-sm" />
                </TooltipIconButton>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
