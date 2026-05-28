import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  pipelines: {
    getPipelineForProject: vi.fn(),
    createPipeline: vi.fn(),
    getPipelineById: vi.fn(),
    getPipelinesByProject: vi.fn(),
    updatePipeline: vi.fn(),
    deletePipeline: vi.fn(),
  },
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ pipelines: mocks.pipelines }),
}));

import {
  getPipelineForProject,
  createPipeline,
  getPipelineById,
  getPipelinesByProject,
  updatePipeline,
  deletePipeline,
  cancelPipelineRun,
} from '../../services/pipeline-manager.js';

describe('pipeline-manager CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('getPipelineForProject maps repository row to PipelineConfig', async () => {
    mocks.pipelines.getPipelineForProject.mockResolvedValue({
      id: 'pipe-1',
      projectId: 'p-1',
      userId: 'u-1',
      name: 'Review',
      enabled: 1,
      reviewModel: 'sonnet',
      fixModel: 'opus',
      maxIterations: 2,
      precommitFixEnabled: 1,
      precommitFixModel: 'sonnet',
      precommitFixMaxIterations: 1,
      reviewerPrompt: 'Be strict',
      testEnabled: 0,
      testFixEnabled: 0,
      testFixModel: 'sonnet',
      testFixMaxIterations: 3,
    });

    const config = await getPipelineForProject('p-1');

    expect(config).toEqual(
      expect.objectContaining({
        id: 'pipe-1',
        projectId: 'p-1',
        enabled: true,
        reviewModel: 'sonnet',
        precommitFixEnabled: true,
        reviewerPrompt: 'Be strict',
        testFixMaxIterations: 3,
      }),
    );
  });

  test('getPipelineForProject returns null when missing', async () => {
    mocks.pipelines.getPipelineForProject.mockResolvedValue(null);

    await expect(getPipelineForProject('missing')).resolves.toBeNull();
  });

  test('delegates create/get/update/delete to repository', async () => {
    mocks.pipelines.createPipeline.mockResolvedValue('pipe-new');
    mocks.pipelines.getPipelineById.mockResolvedValue({ id: 'pipe-1' });
    mocks.pipelines.getPipelinesByProject.mockResolvedValue([{ id: 'pipe-1' }]);
    mocks.pipelines.updatePipeline.mockResolvedValue(undefined);
    mocks.pipelines.deletePipeline.mockResolvedValue(undefined);

    await expect(createPipeline({ projectId: 'p-1', userId: 'u-1', name: 'Review' })).resolves.toBe(
      'pipe-new',
    );
    await expect(getPipelineById('pipe-1')).resolves.toEqual({ id: 'pipe-1' });
    await expect(getPipelinesByProject('p-1')).resolves.toEqual([{ id: 'pipe-1' }]);
    await expect(updatePipeline('pipe-1', { enabled: false })).resolves.toBeUndefined();
    await expect(deletePipeline('pipe-1')).resolves.toBeUndefined();
  });
});

describe('cancelPipelineRun', () => {
  test('returns false when run is not active', () => {
    expect(cancelPipelineRun('missing-run')).toBe(false);
  });
});
