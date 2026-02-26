import { Inbox } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { useAutomationStore } from '@/stores/automation-store';
import { useUIStore } from '@/stores/ui-store';

export function AutomationInboxButton() {
  const navigate = useNavigate();
  const inboxCount = useAutomationStore((s) => s.inboxCount);
  const loadInbox = useAutomationStore((s) => s.loadInbox);
  const automationInboxOpen = useUIStore((s) => s.automationInboxOpen);

  // Keep a stable ref to avoid restarting the interval on re-renders
  const loadInboxRef = useRef(loadInbox);
  loadInboxRef.current = loadInbox;

  // Load all inbox items; inboxCount is derived as pending count in the store
  useEffect(() => {
    loadInboxRef.current();
    const interval = setInterval(() => loadInboxRef.current(), 60_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <button
      onClick={() => {
        if (automationInboxOpen) {
          navigate('/');
        } else {
          navigate('/inbox');
        }
      }}
      className={`flex w-full items-center gap-2 rounded-md p-2 text-sm transition-colors ${
        automationInboxOpen
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
      }`}
    >
      <Inbox className="h-4 w-4" />
      <span>Automation Inbox</span>
      {inboxCount > 0 && (
        <Badge variant="secondary" className="ml-auto h-5 min-w-5 px-1 leading-none">
          {inboxCount}
        </Badge>
      )}
    </button>
  );
}
