import { Inbox } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAutomationInbox } from '@/data/automations/hooks';
import { loadInbox } from '@/data/automations/loaders';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { useUIStore } from '@/stores/ui-store';

const BASE_POLL_MS = 60_000;
const MAX_POLL_MS = 300_000; // 5 min cap

/**
 * Sidebar top-bar icon that opens the Automation Inbox, with a badge for the
 * pending runs. It also polls the inbox, so it must stay mounted. `className`
 * lets the top bar keep it visible while it has pending items.
 */
export function AutomationInboxButton({ className }: { className?: string }) {
  const navigate = useNavigate();
  const { pendingCount: inboxCount } = useAutomationInbox();
  const automationInboxOpen = useUIStore((s) => s.automationInboxOpen);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  // The cleanup clears the current retry timeout, while cancelled prevents an in-flight poll reschedule.
  // react-doctor-disable-next-line effect-needs-cleanup
  useEffect(() => {
    if (!isAuthenticated) return;

    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const poll = async () => {
      const result = await loadInbox();
      failures = result.isOk() ? 0 : failures + 1; // reset on success
      if (cancelled) return;
      // Exponential backoff: 60s, 120s, 240s, capped at 5 min
      const delay = Math.min(BASE_POLL_MS * Math.pow(2, failures), MAX_POLL_MS);
      timer = setTimeout(poll, delay);
    };

    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [isAuthenticated]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={automationInboxOpen ? 'active' : inboxCount > 0 ? 'ghost-info' : 'muted'}
          size="icon-sm"
          tabIndex={-1}
          data-testid="sidebar-automation-inbox"
          aria-label="Automation Inbox"
          onClick={() => {
            navigate(buildPath(automationInboxOpen ? '/' : '/inbox'));
          }}
          className={cn('relative', className)}
        >
          <Inbox className="icon-base" />
          {inboxCount > 0 && (
            <span
              // The theme's info blue, darkened so the white count stays readable.
              className="text-3xs absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--color-status-info),black_40%)] px-0.5 leading-none font-medium text-white"
              data-testid="sidebar-automation-inbox-badge"
            >
              {inboxCount > 99 ? '99+' : inboxCount}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Automation Inbox</TooltipContent>
    </Tooltip>
  );
}
