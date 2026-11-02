import { Bot, MoreHorizontal, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useThreadById } from '@/lib/thread-selectors';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

/**
 * Session actions for the browser panel: end a thread-bound session for good
 * (closing the panel only detaches it) and wipe the persistent profile.
 */
export function BrowserSessionMenu() {
  const sessionId = useBrowserPanelStore((s) => s.sessionId);
  const endBrowserSession = useBrowserPanelStore((s) => s.endBrowserSession);
  const clearBrowserProfile = useBrowserPanelStore((s) => s.clearBrowserProfile);
  const [confirmClear, setConfirmClear] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            tabIndex={-1}
            aria-label="Browser session actions"
            data-testid="browser-panel-session-menu"
            className="text-muted-foreground"
          >
            <MoreHorizontal className="icon-base" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={!sessionId}
            onSelect={() => void endBrowserSession()}
            data-testid="browser-panel-close-session"
          >
            <XCircle className="icon-base" />
            Close browser session
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setConfirmClear(true)}
            data-testid="browser-panel-clear-profile"
            className="text-destructive"
          >
            <Trash2 className="icon-base" />
            Clear browser profile…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent data-testid="browser-panel-clear-profile-dialog">
          <DialogHeader>
            <DialogTitle>Clear browser profile?</DialogTitle>
            <DialogDescription>
              Closes every browser session on your runner and deletes its cookies, logins and site
              data. Agents and you will need to sign in to sites again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmClear(false)}
              data-testid="browser-panel-clear-profile-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmClear(false);
                void clearBrowserProfile();
              }}
              data-testid="browser-panel-clear-profile-confirm"
            >
              Clear profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "Shared with the agent" label shown while the panel shows a thread's session. */
export function BrowserSessionThreadLabel({ style }: { style?: React.CSSProperties }) {
  const sessionThreadId = useBrowserPanelStore((s) => s.sessionThreadId);
  const thread = useThreadById(sessionThreadId);
  if (!sessionThreadId) return null;
  return (
    <div
      data-testid="browser-panel-thread-label"
      className="text-muted-foreground flex min-w-0 items-center gap-1"
      style={style}
    >
      <Bot className="icon-sm shrink-0" />
      <span className="truncate">
        Shared with the agent of {thread?.title ? `“${thread.title}”` : 'this thread'}
      </span>
    </div>
  );
}
