import { toast } from 'sonner';

import { createClientLogger } from '@/lib/client-logger';
import { metric } from '@/lib/telemetry';

const log = createClientLogger('ws');
let notified = false;

/**
 * The server rejected `browser.v1` negotiation as incompatible: this tab runs
 * an older client than the server (its generated schema differs). Browser
 * sessions are delivered only over browser.v1, so the panel would wait
 * forever on "Spawning Chrome…". Tell the user once and offer a reload.
 */
export function notifyIncompatibleProtocol(message: string, reload = () => location.reload()) {
  log.warn('browser.v1 negotiation rejected as incompatible', { message });
  metric('ws.protocol_incompatible', 1, { type: 'sum' });
  if (notified) return;
  notified = true;
  toast.warning('Funny was updated', {
    id: 'browser-v1-incompatible',
    description: 'Reload the page to use the browser panel and live updates.',
    duration: Infinity,
    action: { label: 'Reload', onClick: reload },
  });
}

/** Test hook: allow the notice again. */
export function resetProtocolMismatchNotice(): void {
  notified = false;
}
