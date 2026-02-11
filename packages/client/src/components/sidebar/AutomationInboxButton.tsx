import { useEffect } from 'react';
import { Inbox } from 'lucide-react';
import { useAutomationStore } from '@/stores/automation-store';
import { useUIStore } from '@/stores/ui-store';

export function AutomationInboxButton() {
  const inboxCount = useAutomationStore(s => s.inboxCount);
  const loadInbox = useAutomationStore(s => s.loadInbox);
  const automationInboxOpen = useUIStore(s => s.automationInboxOpen);
  const setAutomationInboxOpen = useUIStore(s => s.setAutomationInboxOpen);

  // Load all inbox items; inboxCount is derived as pending count in the store
  useEffect(() => {
    loadInbox();
    const interval = setInterval(() => loadInbox(), 60_000);
    return () => clearInterval(interval);
  }, [loadInbox]);

  return (
    <button
      onClick={() => setAutomationInboxOpen(!automationInboxOpen)}
      className={`w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
        automationInboxOpen
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      }`}
    >
      <Inbox className="h-4 w-4" />
      <span>Automation Inbox</span>
      {inboxCount > 0 && (
        <span className="ml-auto bg-primary text-primary-foreground text-xs rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
          {inboxCount}
        </span>
      )}
    </button>
  );
}
