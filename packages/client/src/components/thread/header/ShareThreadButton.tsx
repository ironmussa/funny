import { Check, Link2, Share2, X } from 'lucide-react';
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
  DialogTrigger,
} from '@/components/ui/dialog';
import { ShortcutHint } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { threadsApi, type ShareLevel, type ThreadShareGrant } from '@/lib/api/threads';
import { createClientLogger } from '@/lib/client-logger';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
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
  return `Can ${level === 'steer' ? 'edit' : level === 'comment' ? 'comment' : 'view'}`;
}

interface ProjectMemberPick {
  userId: string;
  name: string;
}

/**
 * Owner-only "Share" affordance, rendered as a Google-Drive-style modal:
 * invite a member of THIS PROJECT to read+comment on the thread, see who
 * currently has access (with the owner pinned on top), revoke shares, and
 * copy a deep link. The link is identity-gated server-side — only granted
 * users can open it.
 */
export function ShareThreadButton({
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
  const [shares, setShares] = useState<ThreadShareGrant[]>([]);
  const [members, setMembers] = useState<ProjectMemberPick[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // Permission level applied to the NEXT member added: viewer / commenter /
  // editor (view | comment | steer). See `ShareLevel`.
  const [level, setLevel] = useState<ShareLevel>('view');

  // Close the dialog when the active thread changes so a stale open flag from
  // a previous (owned) thread can't pop the dialog on an unrelated thread.
  useEffect(() => {
    setOpen(false);
    // Intentionally only on threadId change, not on setOpen identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const refreshShares = useCallback(async () => {
    const res = await threadsApi.listThreadShares(threadId);
    res.match(
      (rows) => setShares(rows),
      (err) => log.warn('Failed to list thread shares', { error: String(err) }),
    );
  }, [threadId]);

  useEffect(() => {
    if (!open) return;
    void refreshShares();
    void api.listProjectMembers(projectId).then((res) => {
      res.match(
        ({ members: rows }) => {
          const list: ProjectMemberPick[] = rows
            .map((m) => ({
              userId: m.userId,
              name: m.user?.name ?? m.user?.username ?? m.user?.email ?? m.userId,
            }))
            .filter((m) => m.userId && m.userId !== selfId);
          setMembers(list);
        },
        (err) => log.warn('Failed to load project members', { error: String(err) }),
      );
    });
  }, [open, projectId, selfId, refreshShares]);

  const share = async (userId: string) => {
    setBusy(true);
    const res = await threadsApi.shareThread(threadId, userId, level);
    res.mapErr((err) => {
      log.warn('Failed to share thread', { error: String(err) });
      toast.error('Could not share thread', { description: String(err) });
    });
    await refreshShares();
    setBusy(false);
  };

  const revoke = async (userId: string) => {
    setBusy(true);
    await threadsApi.unshareThread(threadId, userId);
    await refreshShares();
    setBusy(false);
  };

  const copyLink = () => {
    const url = `${window.location.origin}${buildPath(
      getThreadRoute({ id: threadId, projectId, isScratch: false }),
    )}`;
    void navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!isOwner) return null;

  const sharedIds = new Set(shares.map((s) => s.sharedWithUserId));
  const pickable = members.filter((m) => !sharedIds.has(m.userId));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="header-share-thread"
              className={shares.length > 0 ? 'text-status-info' : 'text-muted-foreground'}
            >
              <Share2 className="icon-base" />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <ShortcutHint label="Share thread" keys={['Alt', 'H']} />
        </TooltipContent>
      </Tooltip>

      <DialogContent
        className="max-w-md gap-0 overflow-hidden p-0"
        data-testid="share-thread-dialog"
      >
        <DialogHeader className="min-w-0 px-6 pt-6 pb-0">
          <DialogTitle className="min-w-0 break-words" style={{ overflowWrap: 'anywhere' }}>
            {threadTitle ? `Share “${threadTitle}”` : 'Share this thread'}
          </DialogTitle>
        </DialogHeader>

        {/* Access-level picker applied to the next member added. */}
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
                onClick={() => setLevel(lvl)}
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
          <p className="text-muted-foreground mt-1.5 text-[11px]">{LEVEL_HINT[level]}</p>
        </div>

        <div className="min-w-0 px-6 pt-4">
          <Command className="rounded-lg border" shouldFilter>
            <CommandInput placeholder="Add a project member…" className="h-10" />
            <CommandList className="max-h-44">
              <CommandEmpty className="text-muted-foreground py-6 text-center text-sm">
                No project members to add.
              </CommandEmpty>
              <CommandGroup>
                {pickable.map((m) => (
                  <CommandItem
                    key={m.userId}
                    value={m.name}
                    disabled={busy}
                    onSelect={() => void share(m.userId)}
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

        <div className="min-w-0 px-6 pt-5">
          <p className="text-muted-foreground mb-2 text-xs font-medium">People with access</p>
          <div className="space-y-1" data-testid="share-current-list">
            {/* Owner row (you) — always pinned on top, not revocable */}
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

            {shares.map((s) => (
              <div
                key={s.sharedWithUserId}
                className="hover:bg-muted/50 flex items-center gap-3 rounded-md px-1 py-1.5"
                data-testid={`share-row-${s.sharedWithUserId}`}
              >
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback name={s.user?.name ?? s.sharedWithUserId} className="text-xs">
                    {(s.user?.name ?? '?').charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{s.user?.name ?? s.sharedWithUserId}</p>
                </div>
                <span
                  className="text-muted-foreground shrink-0 text-xs"
                  data-testid={`share-row-level-${s.sharedWithUserId}`}
                >
                  {accessLabel(s.level ?? 'view')}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-status-danger h-7 w-7 shrink-0"
                  disabled={busy}
                  onClick={() => revoke(s.sharedWithUserId)}
                  data-testid={`share-revoke-${s.sharedWithUserId}`}
                  aria-label="Remove access"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className="mt-5 items-center justify-between border-t px-6 py-4 sm:justify-between">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={copyLink}
            data-testid="share-copy-link"
          >
            {copied ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <DialogClose asChild>
            <Button size="sm" data-testid="share-done">
              Done
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
