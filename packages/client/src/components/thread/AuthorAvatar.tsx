import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  author: string;
}

/**
 * Tooltip-wrapped avatar showing the author's initials. Extracted so
 * MemoizedMessageList doesn't need to import Avatar / AvatarFallback
 * directly.
 */
export function AuthorAvatar({ author }: Props) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar className="mt-0.5">
          <AvatarFallback className="text-xs font-medium text-primary" name={author}>
            {author.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent side="top">{author}</TooltipContent>
    </Tooltip>
  );
}
