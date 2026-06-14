import { useMemo } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuthStore } from '@/stores/auth-store';
import { usePresenceStore } from '@/stores/presence-store';

/**
 * Live presence for a shared thread: a stack of avatars for the OTHER users
 * currently viewing it (self excluded, multi-tab users collapsed). Renders
 * nothing when nobody else is watching. Fed by the presence store (WS).
 */
export function PresenceAvatars({ threadId }: { threadId: string }) {
  const selfId = useAuthStore((s) => s.user?.id ?? null);
  // Select the raw roster (stable reference unless this thread's roster
  // changes) and derive the deduped/self-excluded list in a memo, so the
  // component does not re-render on unrelated presence-store updates.
  const roster = usePresenceStore((s) => s.viewersByThread[threadId]);
  const viewers = useMemo(() => {
    const byUser = new Map<string, { id: string; name: string; image: string | null }>();
    for (const v of roster ?? []) {
      if (v.user.id === selfId) continue;
      if (!byUser.has(v.user.id)) byUser.set(v.user.id, v.user);
    }
    return Array.from(byUser.values());
  }, [roster, selfId]);

  if (viewers.length === 0) return null;

  const shown = viewers.slice(0, 4);
  const extra = viewers.length - shown.length;

  return (
    <div className="flex items-center" data-testid="presence-avatars">
      <div className="flex -space-x-1.5">
        {shown.map((u) => (
          <Tooltip key={u.id}>
            <TooltipTrigger asChild>
              <Avatar
                className="ring-background h-5 w-5 ring-2"
                data-testid={`presence-avatar-${u.id}`}
              >
                {u.image && <AvatarImage src={u.image} alt={u.name} />}
                <AvatarFallback name={u.name} className="text-[9px]">
                  {u.name.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent>{u.name}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      {extra > 0 && <span className="text-muted-foreground ml-1 text-xs">+{extra}</span>}
    </div>
  );
}
