import { Input } from '@/components/ui/input';

interface RemoteUrlFieldsProps {
  remoteUrl: string;
  onRemoteUrlChange: (url: string) => void;
  savingRemote: boolean;
  remoteError: string | null;
}

/** The "Remote URL" tab of the publish dialog: an existing remote to set as origin. */
export function RemoteUrlFields({
  remoteUrl,
  onRemoteUrlChange,
  savingRemote,
  remoteError,
}: RemoteUrlFieldsProps) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <label htmlFor="publish-remote-url" className="text-sm font-medium">
          Remote URL
        </label>
        <Input
          id="publish-remote-url"
          data-testid="publish-remote-url"
          value={remoteUrl}
          onChange={(e) => onRemoteUrlChange(e.target.value)}
          placeholder="https://github.com/user/repo.git"
          disabled={savingRemote}
          autoFocus
        />
        <p className="text-muted-foreground text-xs">
          Sets <code className="text-foreground">origin</code> on this project. The remote must
          already exist; create the empty repository on your provider first, then push from the
          toolbar.
        </p>
      </div>

      {remoteError && (
        <p className="text-destructive text-sm" data-testid="publish-remote-error">
          {remoteError}
        </p>
      )}
    </div>
  );
}
