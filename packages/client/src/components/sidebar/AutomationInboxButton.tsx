import { Inbox } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { NavItem } from '@/components/ui/nav-item';
import { buildPath } from '@/lib/url';
import { useAutomationStore } from '@/stores/automation-store';
import { useUIStore } from '@/stores/ui-store';

export function AutomationInboxButton() {
  const navigate = useNavigate();
  const inboxCount = useAutomationStore((s) => s.inboxCount);
  const loadInbox = useAutomationStore((s) => s.loadInbox);
  const automationInboxOpen = useUIStore((s) => s.automationInboxOpen);

  const loadInboxRef = useRef(loadInbox);
  loadInboxRef.current = loadInbox;

  useEffect(() => {
    loadInboxRef.current();
    const interval = setInterval(() => loadInboxRef.current(), 60_000);
    return () => clearInterval(interval);
  }, []);

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
