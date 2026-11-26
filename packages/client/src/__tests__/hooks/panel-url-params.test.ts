import { beforeEach, describe, expect, test } from 'bun:test';

import { syncPanelParam, syncTabParam } from '@/hooks/use-thread-project-sync';
import { useUIStore } from '@/stores/ui-store';

const ui = () => useUIStore.getState();

describe('?panel= and ?tab= (tool-panels)', () => {
  beforeEach(() => {
    useUIStore.setState({ openPanels: {}, testRunnerOpen: false, reviewSubTab: 'changes' });
  });

  test.each(['review', 'files', 'comments', 'activity'] as const)(
    '?panel=%s opens that panel on the right',
    (id) => {
      syncPanelParam(`?panel=${id}`, ui());
      expect(ui().openPanels.right).toBe(id);
    },
  );

  test('?panel=tests opens the test runner view, not a panel', () => {
    syncPanelParam('?panel=tests', ui());
    expect(ui().testRunnerOpen).toBe(true);
    expect(ui().openPanels.right).toBeUndefined();
  });

  test('an unknown panel changes nothing', () => {
    useUIStore.setState({ openPanels: { right: 'files' } });
    syncPanelParam('?panel=nope', ui());
    expect(ui().openPanels.right).toBe('files');
  });

  test('?panel=review&tab=graph opens review on its History tab', () => {
    syncPanelParam('?panel=review&tab=graph', ui());
    syncTabParam('?panel=review&tab=graph', ui());
    expect(ui().openPanels.right).toBe('review');
    expect(ui().reviewSubTab).toBe('graph');
  });
});
