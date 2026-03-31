import type { PRReviewThread } from '@funny/shared';
import { MessageSquare } from 'lucide-react';
import { useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

import { DiffCommentThread } from './DiffCommentThread';

interface DiffCommentIndicatorProps {
  threads: PRReviewThread[];
}

export function DiffCommentIndicator({ threads }: DiffCommentIndicatorProps) {
  const [open, setOpen] = useState(false);
  const totalComments = threads.reduce((acc, t) => acc + t.comments.length, 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="inline-flex items-center gap-0.5 rounded bg-blue-500/20 px-1 py-0.5 text-[10px] font-medium text-blue-400 hover:bg-blue-500/30"
          data-testid={`comment-indicator-${threads[0]?.id}`}
        >
          <MessageSquare className="h-2.5 w-2.5" />
          {totalComments}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        className="w-auto border-0 bg-transparent p-0 shadow-none"
      >
        <div className="space-y-2">
          {threads.map((thread) => (
            <DiffCommentThread key={thread.id} thread={thread} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
