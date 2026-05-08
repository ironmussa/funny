import { Inbox } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { NavItem } from '@/components/ui/nav-item';
import { buildPath } from '@/lib/url';
import { useAuthStore } from '@/stores/auth-store';
import { useAutomationStore } from '@/stores/automation-store';
import { useUIStore } from '@/stores/ui-store';

const BASE_POLL_MS = 60_000;
const MAX_POLL_MS = 300_000; // 5 min cap

export function AutomationInboxButton() {
  const navigate = useNavigate();
  const inboxCount = useAutomationStore((s) => s.inboxCount);
  const loadInbox = useAutomationStore((s) => s.loadInbox);
  const automationInboxOpen = useUIStore((s) => s.automationInboxOpen);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const loadInboxRef = useRef(loadInbox);
  loadInboxRef.current = loadInbox;

  useEffect(() => {
    if (!isAuthenticated) return;

    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        await loadInboxRef.current();
        failures = 0; // reset on success
      } catch {
        failures++;
      }
      // Exponential backoff: 60s, 120s, 240s, capped at 5 min
      const delay = Math.min(BASE_POLL_MS * Math.pow(2, failures), MAX_POLL_MS);
      timer = setTimeout(poll, delay);
    };

    poll();
    return () => clearTimeout(timer);
  }, [isAuthenticated]);

  return (
    <NavItem
      icon={Inbox}
      label="Automation Inbox"
      count={inboxCount}
      isActive={automationInboxOpen}
      data-testid="sidebar-automation-inbox"
      onClick={() => {
        navigate(buildPath(automationInboxOpen ? '/' : '/inbox'));
      }}
    />
  );
}
