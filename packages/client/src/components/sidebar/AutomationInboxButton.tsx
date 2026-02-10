import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { useAutomationStore } from '@/stores/automation-store';

export function AutomationInboxButton() {
  const navigate = useNavigate();
  const inboxCount = useAutomationStore(s => s.inboxCount);
  const loadInbox = useAutomationStore(s => s.loadInbox);

  useEffect(() => {
    loadInbox();
    const interval = setInterval(loadInbox, 60_000);
    return () => clearInterval(interval);
  }, [loadInbox]);

  return (
    <button
      onClick={() => navigate('/settings/automations')}
      className="w-full flex items-center gap-3 px-4 py-2 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
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
