import { useEffect, useState, type ReactNode } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { authorAvatarUrl } from '@/lib/author-avatar';
import { useCachedAvatar } from '@/lib/avatar-cache';
import { cn } from '@/lib/utils';

const emailUrlCache = new Map<string, string>();

type Size = 'xs' | 'sm';

const SIZE_CLASSES: Record<Size, { avatar: string; text: string }> = {
  xs: { avatar: 'h-3.5 w-3.5', text: 'text-[8px]' },
  sm: { avatar: 'h-4 w-4', text: 'text-[9px]' },
};

export interface AuthorBadgeProps {
  name: string;
  avatarUrl?: string | null;
  email?: string | null;
  size?: Size;
  className?: string;
  children?: ReactNode;
}

export function AuthorBadge({
  name,
  avatarUrl,
  email,
  size = 'xs',
  className,
  children,
}: AuthorBadgeProps) {
  const { avatar: avatarSize, text: fallbackText } = SIZE_CLASSES[size];
  const [emailUrl, setEmailUrl] = useState<string | null>(() =>
    email ? (emailUrlCache.get(email) ?? null) : null,
  );

  useEffect(() => {
    if (!email || avatarUrl || emailUrlCache.has(email)) return;
    let cancelled = false;
    authorAvatarUrl(email).then((resolved) => {
      if (cancelled || !resolved) return;
      emailUrlCache.set(email, resolved);
      setEmailUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [email, avatarUrl]);

  const url = avatarUrl ?? emailUrl;
  // Serve from the short-TTL blob cache so re-rendering many badges (e.g. the
  // virtualized History list) doesn't re-hit GitHub for the same image.
  const cachedUrl = useCachedAvatar(url);

  return (
    <span className={cn('flex min-w-0 items-center gap-1 truncate', className)}>
      <Avatar className={avatarSize}>
        {cachedUrl && <AvatarImage src={cachedUrl} alt={name} />}
        <AvatarFallback name={name} className={fallbackText}>
          {name.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{children ?? name}</span>
    </span>
  );
}
