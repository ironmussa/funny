import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useAutomationStore } from '@/stores/automation-store';
import { useUIStore } from '@/stores/ui-store';

export function AutomationInboxButton() {
  const navigate = useNavigate();
  const inboxCount = useAutomationStore(s => s.inboxCount);
  const loadInbox = useAutomationStore(s => s.loadInbox);
  const automationInboxOpen = useUIStore(s => s.automationInboxOpen);

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
      className={`w-full flex items-center gap-3 px-2 py-2 text-sm rounded-md transition-colors ${
        automationInboxOpen
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      }`}
    >
      <Inbox className="h-4 w-4" />
      <span>Automation Inbox</span>
      {inboxCount > 0 && (
        <Badge className="ml-auto h-5 min-w-5 justify-center rounded-full px-1 text-xs leading-none">
          {inboxCount}
        </Badge>
      )}
    </button>
  );
}
