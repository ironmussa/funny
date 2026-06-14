import { Check, Link2, Share2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { threadsApi, type ThreadShareGrant } from '@/lib/api/threads';
import { authClient } from '@/lib/auth-client';
import { createClientLogger } from '@/lib/client-logger';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { useAuthStore } from '@/stores/auth-store';
import { useThreadSelector } from '@/stores/thread-context';

const log = createClientLogger('thread-share');

interface OrgMember {
  userId: string;
  name: string;
  image: string | null;
}

/**
 * Owner-only "Share" affordance: invite a specific org member to read+comment
 * on this thread, list/revoke current shares, and copy a deep link. The link
 * is identity-gated server-side — only granted users can open it.
 */
export function ShareThreadButton({
  threadId,
  projectId,
}: {
  threadId: string;
  projectId: string;
}) {
  const selfId = useAuthStore((s) => s.user?.id ?? null);
  const orgId = useAuthStore((s) => s.activeOrgId);
  const ownerId = useThreadSelector((t) => t?.userId ?? null);
  const isOwner = !!selfId && ownerId === selfId;

  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<ThreadShareGrant[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

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
    if (!orgId) {
      setMembers([]);
      return;
    }
    authClient.organization
      .getFullOrganization({ query: { organizationId: orgId } })
      .then((res: any) => {
        const list: OrgMember[] = (res?.data?.members ?? []).map((m: any) => ({
          userId: m.userId ?? m.user?.id,
          name: m.user?.name ?? m.user?.email ?? m.userId,
          image: m.user?.image ?? null,
        }));
        setMembers(list.filter((m) => m.userId && m.userId !== selfId));
      })
      .catch((err: Error) => log.warn('Failed to load org members', { error: err.message }));
  }, [open, orgId, selfId, refreshShares]);

  const share = async (userId: string) => {
    setBusy(true);
    const res = await threadsApi.shareThread(threadId, userId);
    res.mapErr((err) => log.warn('Failed to share thread', { error: String(err) }));
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
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="header-share-thread"
              className={shares.length > 0 ? 'text-status-info' : 'text-muted-foreground'}
            >
              <Share2 className="icon-base" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Share thread</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-72 p-0" align="end" data-testid="share-thread-popover">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Share this thread</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-xs"
            onClick={copyLink}
            data-testid="share-copy-link"
          >
            {copied ? <Check className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>

        {shares.length > 0 && (
          <div className="border-b px-1 py-1" data-testid="share-current-list">
            {shares.map((s) => (
              <div
                key={s.sharedWithUserId}
                className="flex items-center gap-2 rounded-md px-2 py-1"
                data-testid={`share-row-${s.sharedWithUserId}`}
              >
                <Avatar className="h-5 w-5">
                  {s.user?.image && <AvatarImage src={s.user.image} alt={s.user?.name ?? ''} />}
                  <AvatarFallback name={s.user?.name ?? s.sharedWithUserId} className="text-[9px]">
                    {(s.user?.name ?? '?').charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="flex-1 truncate text-xs">
                  {s.user?.name ?? s.sharedWithUserId}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-status-danger h-5 w-5"
                  disabled={busy}
                  onClick={() => revoke(s.sharedWithUserId)}
                  data-testid={`share-revoke-${s.sharedWithUserId}`}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <Command>
          <CommandInput placeholder="Add an org member…" className="h-9 text-xs" />
          <CommandList>
            <CommandEmpty className="text-muted-foreground py-3 text-center text-xs">
              {orgId ? 'No members to add.' : 'Select an organization to share.'}
            </CommandEmpty>
            <CommandGroup>
              {pickable.map((m) => (
                <CommandItem
                  key={m.userId}
                  value={m.name}
                  disabled={busy}
                  onSelect={() => void share(m.userId)}
                  className="gap-2 text-xs"
                  data-testid={`share-add-${m.userId}`}
                >
                  <Avatar className="h-5 w-5">
                    {m.image && <AvatarImage src={m.image} alt={m.name} />}
                    <AvatarFallback name={m.name} className="text-[9px]">
                      {m.name.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate">{m.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
