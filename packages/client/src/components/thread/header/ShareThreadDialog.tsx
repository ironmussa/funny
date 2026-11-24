import { Check, Link2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { api } from '@/lib/api';
import { threadsApi, type ShareLevel, type ThreadShareGrant } from '@/lib/api/threads';
import { createClientLogger } from '@/lib/client-logger';
import {
  getThreadRoute,
  steerReachesProjectSecrets,
  steerReachesRepository,
} from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { whilePending } from '@/lib/while-pending';
import { useAuthStore } from '@/stores/auth-store';
import { useThreadSelector } from '@/stores/thread-context';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('thread-share');

/** Short label per share level, shown in the picker. */
const LEVEL_LABEL: Record<ShareLevel, string> = {
  view: 'Viewer',
  comment: 'Commenter',
  steer: 'Editor',
};

/** One-line description of what each level grants. */
const LEVEL_HINT: Record<ShareLevel, string> = {
  view: 'View the thread (read-only).',
  comment: 'View the thread and leave comments.',
  steer: 'View, comment, read-only git, and send follow-ups to the agent.',
};

/** Human label for a grant's level, shown next to a person in the access list. */
function accessLabel(level: ShareLevel): string {
  // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
  return `Can ${level === 'steer' ? 'edit' : level === 'comment' ? 'comment' : 'view'}`;
}

interface ProjectMemberPick {
  userId: string;
  name: string;
}

/** A project member as the picker lists them: anyone but the caller. */
function toMemberPick(member: {
  userId: string;
  user?: { name?: string | null; username?: string | null; email?: string | null } | null;
}): ProjectMemberPick {
  const user = member.user;
  return {
    userId: member.userId,
    name: user?.name ?? user?.username ?? user?.email ?? member.userId,
  };
}

/**
 * The thread's shares and the project members it can be shared with, read
 * while the dialog is open, and sharing / revoking (each refreshes the list).
 */
function useThreadShares({
  threadId,
  projectId,
  open,
  selfId,
}: {
  threadId: string;
  projectId: string;
  open: boolean;
  selfId: string | null;
}) {
  const [shares, setShares] = useState<ThreadShareGrant[]>([]);
  const [members, setMembers] = useState<ProjectMemberPick[]>([]);
  const [busy, setBusy] = useState(false);

  const refreshShares = useCallback(async () => {
    const res = await threadsApi.listThreadShares(threadId);
    res.match(setShares, (err) => log.warn('Failed to list thread shares', { error: String(err) }));
  }, [threadId]);

  useEffect(() => {
    if (!open) return;
    void refreshShares();
    void api.listProjectMembers(projectId).then((res) =>
      res.match(
        ({ members: rows }) =>
          setMembers(rows.map(toMemberPick).filter((m) => m.userId && m.userId !== selfId)),
        (err) => log.warn('Failed to load project members', { error: String(err) }),
      ),
    );
  }, [open, projectId, selfId, refreshShares]);

  /** Run `action`, then re-read the shares, with the buttons disabled meanwhile. */
  const busyWhile = async <Done,>(action: () => Promise<Done>) => {
    await whilePending(setBusy, async () => {
      await action();
      await refreshShares();
    });
  };

  const share = (userId: string, level: ShareLevel) =>
    busyWhile(async () => {
      const res = await threadsApi.shareThread(threadId, userId, level);
      res.mapErr((err) => {
        log.warn('Failed to share thread', { error: String(err) });
        toast.error('Could not share thread', { description: String(err) });
      });
    });

  const revoke = (userId: string) =>
    busyWhile(async () => {
      await threadsApi.unshareThread(threadId, userId);
    });

  return { shares, members, busy, share, revoke };
}

/**
 * Owner-only "Share" dialog, Google-Drive-style. It has no trigger of its own:
 * the thread header's "More actions" menu and the Alt+H shortcut open it
 * through `shareDialogOpen` in the UI store. While mounted for the owner it
 * renders a hidden `share-thread-available` marker so the shortcut knows a
 * dialog exists to open. In the dialog the owner can:
 * invite a member of THIS PROJECT to read+comment on the thread, see who
 * currently has access (with the owner pinned on top), revoke shares, and
 * copy a deep link. The link is identity-gated server-side — only granted
 * users can open it.
 */
export function ShareThreadDialog({
  threadId,
  projectId,
}: {
  threadId: string;
  projectId: string;
}) {
  const selfId = useAuthStore((s) => s.user?.id ?? null);
  const selfName = useAuthStore((s) => s.user?.displayName ?? s.user?.username ?? 'You');
  const ownerId = useThreadSelector((t) => t?.userId ?? null);
  const threadTitle = useThreadSelector((t) => t?.title ?? null);
  const isOwner = !!selfId && ownerId === selfId;

  // Open state lives in the UI store so the Alt+H global shortcut can toggle
  // it. Reset to false whenever the thread changes (this dialog only mounts on
  // owned threads, but the flag would otherwise leak across navigation).
  const open = useUIStore((s) => s.shareDialogOpen);
  const setOpen = useUIStore((s) => s.setShareDialogOpen);
  const [copied, copy] = useCopyToClipboard();
  // Permission level applied to the NEXT member added: viewer / commenter /
  // editor (view | comment | steer). See `ShareLevel`.
  const [level, setLevel] = useState<ShareLevel>('view');
  const { shares, members, busy, share, revoke } = useThreadShares({
    threadId,
    projectId,
    open,
    selfId,
  });

  // Close the dialog when the active thread changes so a stale open flag from
  // a previous (owned) thread can't pop the dialog on an unrelated thread.
  useEffect(() => {
    setOpen(false);
  }, [threadId, setOpen]);

  const copyLink = () => {
    const url = `${window.location.origin}${buildPath(
      getThreadRoute({ id: threadId, projectId, isScratch: false }),
    )}`;
    void copy(url);
  };

  if (!isOwner) return null;

  const sharedIds = new Set(shares.map((s) => s.sharedWithUserId));
  const pickable = members.filter((m) => !sharedIds.has(m.userId));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <span hidden data-testid="share-thread-available" />

      <DialogContent
        className="max-w-md gap-0 overflow-hidden p-0"
        data-testid="share-thread-dialog"
      >
        <DialogHeader className="min-w-0 px-6 pt-6 pb-0">
          <DialogTitle
            className="min-w-0 leading-snug break-words"
            style={{ overflowWrap: 'anywhere' }}
          >
            {threadTitle ? `Share “${threadTitle}”` : 'Share this thread'}
          </DialogTitle>
        </DialogHeader>

        <LevelPicker level={level} onLevel={setLevel} />
        <MemberPicker
          members={pickable}
          busy={busy}
          onPick={(userId) => void share(userId, level)}
        />
        <AccessList
          selfName={selfName}
          shares={shares}
          busy={busy}
          onRevoke={(userId) => void revoke(userId)}
        />
        <ShareFooter copied={copied} onCopyLink={copyLink} />
      </DialogContent>
    </Dialog>
  );
}

/** The access level applied to the next member added. */
function LevelPicker({
  level,
  onLevel,
}: {
  level: ShareLevel;
  onLevel: (level: ShareLevel) => void;
}) {
  return (
    <div className="min-w-0 px-6 pt-4">
      <p className="text-muted-foreground mb-1.5 text-xs font-medium">Access level</p>
      <div
        className="bg-muted/50 inline-flex rounded-md p-0.5"
        role="group"
        data-testid="share-level-picker"
      >
        {(['view', 'comment', 'steer'] as const).map((lvl) => (
          <button
            key={lvl}
            type="button"
            onClick={() => onLevel(lvl)}
            aria-pressed={level === lvl}
            data-testid={`share-level-${lvl}`}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-colors',
              level === lvl
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {LEVEL_LABEL[lvl]}
          </button>
        ))}
      </div>
      <p className="text-muted-foreground text-compact mt-1.5">{LEVEL_HINT[level]}</p>
      <SteerRepositoryWarning level={level} />
      <SteerSecretsWarning level={level} />
    </div>
  );
}

/** The project members the thread is not shared with yet. */
function MemberPicker({
  members,
  busy,
  onPick,
}: {
  members: ProjectMemberPick[];
  busy: boolean;
  onPick: (userId: string) => void;
}) {
  return (
    <div className="min-w-0 px-6 pt-4">
      <Command className="rounded-lg border" shouldFilter>
        <CommandInput placeholder="Add a project member…" className="h-10" />
        <CommandList className="max-h-44">
          <CommandEmpty className="text-muted-foreground py-6 text-center text-sm">
            No project members to add.
          </CommandEmpty>
          <CommandGroup>
            {members.map((m) => (
              <CommandItem
                key={m.userId}
                value={m.name}
                disabled={busy}
                onSelect={() => onPick(m.userId)}
                className="gap-2"
                data-testid={`share-add-${m.userId}`}
              >
                <Avatar className="h-7 w-7 shrink-0">
                  <AvatarFallback name={m.name} className="text-xs">
                    {m.name.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate text-sm">{m.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}

/** One person the thread is shared with, and the button that removes them. */
function ShareRow({
  share,
  busy,
  onRevoke,
}: {
  share: ThreadShareGrant;
  busy: boolean;
  onRevoke: (userId: string) => void;
}) {
  const name = share.user?.name ?? share.sharedWithUserId;
  return (
    <div
      className="hover:bg-muted/50 flex items-center gap-3 rounded-md px-1 py-1.5"
      data-testid={`share-row-${share.sharedWithUserId}`}
    >
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback name={name} className="text-xs">
          {(share.user?.name ?? '?').charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{name}</p>
      </div>
      <span
        className="text-muted-foreground shrink-0 text-xs"
        data-testid={`share-row-level-${share.sharedWithUserId}`}
      >
        {accessLabel(share.level ?? 'view')}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-status-error h-7 w-7 shrink-0"
        disabled={busy}
        onClick={() => onRevoke(share.sharedWithUserId)}
        data-testid={`share-revoke-${share.sharedWithUserId}`}
        aria-label="Remove access"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

/** Who has access: the owner pinned on top (not revocable), then every share. */
function AccessList({
  selfName,
  shares,
  busy,
  onRevoke,
}: {
  selfName: string;
  shares: ThreadShareGrant[];
  busy: boolean;
  onRevoke: (userId: string) => void;
}) {
  return (
    <div className="min-w-0 px-6 pt-5">
      <p className="text-muted-foreground mb-2 text-xs font-medium">People with access</p>
      <div className="space-y-1" data-testid="share-current-list">
        <div className="flex items-center gap-3 rounded-md px-1 py-1.5">
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarFallback name={selfName} className="text-xs">
              {selfName.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{selfName} (you)</p>
          </div>
          <span className="text-muted-foreground shrink-0 text-xs">Owner</span>
        </div>
        {shares.map((share) => (
          <ShareRow key={share.sharedWithUserId} share={share} busy={busy} onRevoke={onRevoke} />
        ))}
      </div>
    </div>
  );
}

/** Copy the thread's link, and close. */
function ShareFooter({ copied, onCopyLink }: { copied: boolean; onCopyLink: () => void }) {
  const CopyIcon = copied ? Check : Link2;
  return (
    <DialogFooter className="mt-5 items-center justify-between border-t px-6 py-4 sm:justify-between">
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={onCopyLink}
        data-testid="share-copy-link"
      >
        <CopyIcon className={cn('copy-feedback-icon h-4 w-4', copied && 'text-status-success')} />
        {copied ? 'Copied' : 'Copy link'}
      </Button>
      <DialogClose asChild>
        <Button size="sm" data-testid="share-done">
          Done
        </Button>
      </DialogClose>
    </DialogFooter>
  );
}

/** Shown when choosing Editor on a project thread: its agent holds the project's secrets. */
function SteerSecretsWarning({ level }: { level: ShareLevel }) {
  const applies = useThreadSelector((t) => steerReachesProjectSecrets(t));
  if (level !== 'steer' || !applies) return null;
  return (
    <p className="text-status-warning mt-1.5 text-xs" data-testid="share-steer-secrets-warning">
      The agent of this thread starts with the project&apos;s secrets, your personal ones included.
      An editor can reach them through the agent.
    </p>
  );
}

/** Shown when choosing Editor on a sandbox thread: its agent can act on the repository. */
function SteerRepositoryWarning({ level }: { level: ShareLevel }) {
  const applies = useThreadSelector((t) => steerReachesRepository(t));
  if (level !== 'steer' || !applies) return null;
  return (
    <p className="text-status-warning mt-1.5 text-xs" data-testid="share-steer-repository-warning">
      This thread runs in a sandbox with GitHub access to its repository. An editor can push, open
      pull requests and comment there through the agent, without your approval.
    </p>
  );
}
