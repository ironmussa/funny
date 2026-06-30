import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { HonoEnv } from '../../types/hono-env.js';

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  isProjectInOrg: vi.fn(),
  resolveProjectPath: vi.fn(),
  getThread: vi.fn(),
  dispatch: vi.fn(),
  getActive: vi.fn(),
  abort: vi.fn(),
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      getProject: mocks.getProject,
      isProjectInOrg: mocks.isProjectInOrg,
      resolveProjectPath: mocks.resolveProjectPath,
    },
  }),
}));

vi.mock('../../services/thread-manager.js', () => ({
  getThread: mocks.getThread,
}));

vi.mock('../../services/scheduler-pipeline-bootstrap.js', () => ({
  getSchedulerPipelineDispatcher: () => ({
    dispatch: mocks.dispatch,
    getActive: mocks.getActive,
  }),
}));

import { workflowRuntimeRoutes } from '../../routes/workflows.js';

let workDir: string;

function makeApp(userId: string | null = 'user-1') {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    if (userId) c.set('userId', userId);
    c.set('organizationId', null);
    await next();
  });
  app.route('/workflows', workflowRuntimeRoutes);
  return app;
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'funny-workflow-routes-'));
  mocks.getProject.mockReset();
  mocks.isProjectInOrg.mockReset();
  mocks.resolveProjectPath.mockReset();
  mocks.getThread.mockReset();
  mocks.dispatch.mockReset();
  mocks.getActive.mockReset();
  mocks.abort.mockReset();

  mocks.getProject.mockResolvedValue({ id: 'project-1', userId: 'user-1', path: workDir });
  mocks.isProjectInOrg.mockResolvedValue(false);
  mocks.resolveProjectPath.mockReturnValue(okAsync(workDir));
  mocks.dispatch.mockResolvedValue({
    ok: true,
    handle: { pipelineRunId: 'run-1', abort: mocks.abort, finished: Promise.resolve() },
  });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('workflowRuntimeRoutes', () => {
  test('requires auth', async () => {
    const res = await makeApp(null).request('/workflows?projectId=project-1');
    expect(res.status).toBe(401);
  });

  test('lists built-in workflows for an authorized project', async () => {
    const res = await makeApp().request('/workflows?projectId=project-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflows.map((workflow: { name: string }) => workflow.name)).toContain('commit');
    expect(body.workflows.find((workflow: { name: string }) => workflow.name === 'commit')).toEqual(
      expect.objectContaining({ source: 'built-in', hasOverride: false }),
    );
  });

  test('reads a workflow with parsed and graph data', async () => {
    const res = await makeApp().request('/workflows/commit?projectId=project-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.name).toBe('commit');
    expect(body.parsed.name).toBe('commit');
    expect(body.graph.nodes.length).toBeGreaterThan(0);
  });

  test('validates YAML and returns diagnostics for invalid source', async () => {
    const res = await makeApp().request('/workflows/validate', {
      method: 'POST',
      body: JSON.stringify({ yaml: 'name: BadName\nnodes: []' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.diagnostics.length).toBeGreaterThan(0);
  });

  test('saves project overrides to .funny/workflows', async () => {
    const yaml = `
name: commit
description: Saved override
nodes:
  - id: noop
    notify: { message: "saved" }
`;

    const res = await makeApp().request('/workflows/commit', {
      method: 'PUT',
      body: JSON.stringify({ projectId: 'project-1', yaml }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflow.summary.source).toBe('user');
    expect(body.workflow.parsed.description).toBe('Saved override');

    const saved = await Bun.file(path.join(workDir, '.funny', 'workflows', 'commit.yaml')).text();
    expect(saved).toContain('Saved override');
  });

  test('run rejects missing required workflow inputs before dispatch', async () => {
    const workflowDir = path.join(workDir, '.funny', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      path.join(workflowDir, 'needs-input.yaml'),
      `
name: needs-input
inputs:
  token: { type: string, required: true }
nodes:
  - id: noop
    notify: { message: "{{token}}" }
`,
      'utf8',
    );
    mocks.getThread.mockResolvedValue({
      id: 'thread-1',
      userId: 'user-1',
      projectId: 'project-1',
      title: 'Run it',
    });

    const res = await makeApp().request('/workflows/needs-input/run', {
      method: 'POST',
      body: JSON.stringify({ threadId: 'thread-1' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(400);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  test('run delegates to scheduler dispatcher with workflow name', async () => {
    mocks.getThread.mockResolvedValue({
      id: 'thread-1',
      userId: 'user-1',
      projectId: 'project-1',
      title: 'Run it',
    });

    const res = await makeApp().request('/workflows/fusion/run', {
      method: 'POST',
      body: JSON.stringify({ threadId: 'thread-1', inputs: { question: 'why?' } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe('run-1');
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        pipelineName: 'fusion',
        inputs: expect.objectContaining({ question: 'why?', threadId: 'thread-1' }),
      }),
    );
  });

  test('cancel aborts active runs', async () => {
    mocks.getActive.mockReturnValue({ abort: mocks.abort });
    const res = await makeApp().request('/workflows/runs/run-1/cancel', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, found: true });
    expect(mocks.abort).toHaveBeenCalledOnce();
  });
});
