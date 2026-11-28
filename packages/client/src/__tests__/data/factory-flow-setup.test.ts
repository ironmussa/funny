import { describe, expect, test, vi } from 'vitest';

import { createDataLayer } from '@/data/data-layer';
import { applyFactorySetupUpdated } from '@/data/factory/queries';

describe('applyFactorySetupUpdated (Task 5.2)', () => {
  test('invalidates both flow setup and flow validation queries for the project', () => {
    const layer = createDataLayer({ userId: 'u1' });
    const invalidateSpy = vi.spyOn(layer.queryClient, 'invalidateQueries');

    applyFactorySetupUpdated({ projectId: 'p1', setupId: 'setup-1', state: 'committed' }, layer);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['factory', 'flow-setup', 'p1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['factory', 'flow-validation', 'p1'],
    });
    layer.dispose();
  });

  test('ignores events without a projectId or when the layer is disposed', () => {
    const layer = createDataLayer({ userId: 'u1' });
    const invalidateSpy = vi.spyOn(layer.queryClient, 'invalidateQueries');

    applyFactorySetupUpdated({}, layer);
    expect(invalidateSpy).not.toHaveBeenCalled();

    layer.dispose();
    applyFactorySetupUpdated({ projectId: 'p1', setupId: 's1', state: 'proposed' }, layer);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
