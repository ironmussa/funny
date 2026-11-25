import { Globe, Lock } from 'lucide-react';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

interface RepoVisibilityToggleProps {
  isPrivate: boolean;
  onPrivateChange: (isPrivate: boolean) => void;
  disabled: boolean;
}

/** The private / public switch of the GitHub publish form. */
export function RepoVisibilityToggle({
  isPrivate,
  onPrivateChange,
  disabled,
}: RepoVisibilityToggleProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between rounded-md border px-3 py-2.5',
        'bg-muted/30',
      )}
    >
      <div className="flex items-center gap-2">
        {isPrivate ? (
          <Lock className="text-muted-foreground size-4" />
        ) : (
          <Globe className="text-muted-foreground size-4" />
        )}
        <span className="text-sm">{isPrivate ? 'Private' : 'Public'}</span>
      </div>
      <Switch
        data-testid="publish-repo-private"
        checked={isPrivate}
        onCheckedChange={onPrivateChange}
        disabled={disabled}
      />
    </div>
  );
}
