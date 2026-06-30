/**
 * Runtime workflow routes.
 *
 * Workflow YAML is a project artifact under `.funny/workflows/*.yaml`.
 * The runtime validates and saves those files, then delegates execution to
 * the existing scheduler pipeline dispatcher.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  WorkflowDefinitionResponse,
  WorkflowListResponse,
  WorkflowSaveResponse,
  WorkflowValidateResponse,
} from '@funny/shared/types/workflows';
import {
  loadWorkflowCatalog,
  parseWorkflowYaml,
  workflowToGraph,
  type ParsedWorkflow,
  type WorkflowCatalogEntry,
} from '@funny/workflows';
import { Hono } from 'hono';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { getSchedulerPipelineDispatcher } from '../services/scheduler-pipeline-bootstrap.js';
import { getServices } from '../services/service-registry.js';
import * as tm from '../services/thread-manager.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireProject } from '../utils/route-helpers.js';

export const workflowRuntimeRoutes = new Hono<HonoEnv>();

const NS = 'workflow-routes';
const workflowNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

const validateSchema = z.object({
  yaml: z.string().min(1),
});

const saveSchema = z.object({
  projectId: z.string().min(1),
  yaml: z.string().min(1),
});

const runSchema = z.object({
  threadId: z.string().min(1),
  prompt: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
});

workflowRuntimeRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId is required' }, 400);

  const projectResult = await requireProject(projectId, userId, c.get('organizationId'));
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const catalog = await loadWorkflowCatalog({ repoRoot: projectResult.value.path });
  const body: WorkflowListResponse = {
    workflows: [...catalog.workflows.values()]
      .map(summaryOf)
      .sort((a, b) => a.name.localeCompare(b.name)),
    warnings: catalog.warnings,
  };
  return c.json(body);
});

workflowRuntimeRoutes.get('/:name', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const name = c.req.param('name');
  if (!workflowNameSchema.safeParse(name).success) {
    return c.json({ error: 'Invalid workflow name' }, 400);
  }

  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId is required' }, 400);

  const projectResult = await requireProject(projectId, userId, c.get('organizationId'));
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const catalog = await loadWorkflowCatalog({ repoRoot: projectResult.value.path });
  const entry = catalog.workflows.get(name);
  if (!entry) return c.json({ error: 'Workflow not found' }, 404);

  return c.json(definitionOf(entry));
});

workflowRuntimeRoutes.post('/validate', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const raw = await c.req.json().catch(() => null);
  const parsed = validateSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', issues: issueMessages(parsed.error) }, 400);
  }

  return c.json(validateWorkflowYaml(parsed.data.yaml));
});

workflowRuntimeRoutes.put('/:name', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const name = c.req.param('name');
  if (!workflowNameSchema.safeParse(name).success) {
    return c.json({ error: 'Invalid workflow name' }, 400);
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', issues: issueMessages(parsed.error) }, 400);
  }

  const validation = validateWorkflowYaml(parsed.data.yaml);
  if (!validation.ok || !validation.parsed) return c.json(validation, 400);

  const workflow = validation.parsed as ParsedWorkflow;
  if (workflow.name !== name) {
    return c.json(
      {
        ok: false,
        diagnostics: [{ path: 'name', message: `Workflow name must match route name "${name}"` }],
      },
      400,
    );
  }

  const projectResult = await requireProject(
    parsed.data.projectId,
    userId,
    c.get('organizationId'),
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const workflowDir = path.join(projectResult.value.path, '.funny', 'workflows');
  const filePath = path.join(workflowDir, `${name}.yaml`);
  await mkdir(workflowDir, { recursive: true });
  await writeFile(filePath, parsed.data.yaml, 'utf8');

  const catalog = await loadWorkflowCatalog({ repoRoot: projectResult.value.path });
  const entry = catalog.workflows.get(name);
  if (!entry) return c.json({ error: 'Saved workflow could not be reloaded' }, 500);

  const body: WorkflowSaveResponse = { ok: true, workflow: definitionOf(entry) };
  return c.json(body);
});

workflowRuntimeRoutes.post('/:name/run', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const name = c.req.param('name');
  if (!workflowNameSchema.safeParse(name).success) {
    return c.json({ error: 'Invalid workflow name' }, 400);
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = runSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', issues: issueMessages(parsed.error) }, 400);
  }

  const thread = await tm.getThread(parsed.data.threadId);
  if (!thread) return c.json({ error: 'Thread not found' }, 404);
  if (thread.userId && thread.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  let cwd: string;
  if (thread.worktreePath) {
    cwd = thread.worktreePath;
  } else {
    const pathResult = await getServices().projects.resolveProjectPath(thread.projectId, userId);
    if (pathResult.isErr()) return c.json({ error: pathResult.error.message }, 400);
    cwd = pathResult.value;
  }

  const catalog = await loadWorkflowCatalog({ repoRoot: cwd });
  const entry = catalog.workflows.get(name);
  if (!entry) return c.json({ error: 'Workflow not found' }, 404);

  const effectivePrompt =
    parsed.data.prompt?.trim() ||
    thread.initialPrompt?.trim() ||
    thread.title?.trim() ||
    'Continue.';
  const inputs = {
    ...(parsed.data.inputs ?? {}),
    prompt: parsed.data.inputs?.prompt ?? effectivePrompt,
    threadId: parsed.data.inputs?.threadId ?? thread.id,
  };
  const missing = requiredInputsMissing(entry.workflow, inputs);
  if (missing.length > 0) {
    return c.json(
      {
        error: 'Missing required workflow inputs',
        diagnostics: missing.map((input) => ({
          path: `inputs.${input}`,
          message: `Input "${input}" is required`,
        })),
      },
      400,
    );
  }

  const result = await getSchedulerPipelineDispatcher().dispatch({
    threadId: thread.id,
    projectId: thread.projectId,
    userId,
    cwd,
    prompt: effectivePrompt,
    pipelineName: name,
    inputs,
  });

  if (!result.ok) {
    log.warn('Workflow dispatch failed', {
      namespace: NS,
      workflowName: name,
      threadId: thread.id,
      userId,
      error: result.error.message,
    });
    return c.json({ error: result.error.message }, 502);
  }

  return c.json({
    runId: result.handle.pipelineRunId,
    pipelineRunId: result.handle.pipelineRunId,
  });
});

workflowRuntimeRoutes.post('/runs/:runId/cancel', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const runId = c.req.param('runId');
  const handle = getSchedulerPipelineDispatcher().getActive(runId);
  if (!handle) return c.json({ ok: true, found: false });
  handle.abort();
  return c.json({ ok: true, found: true });
});

function definitionOf(entry: WorkflowCatalogEntry): WorkflowDefinitionResponse {
  return {
    summary: summaryOf(entry),
    yaml: entry.yaml,
    parsed: entry.workflow,
    graph: workflowToGraph(entry.workflow),
    diagnostics: [],
  };
}

function summaryOf(entry: WorkflowCatalogEntry) {
  return {
    name: entry.name,
    description: entry.workflow.description,
    source: entry.source,
    filePath: entry.source === 'user' ? entry.filePath : undefined,
    hasOverride: entry.source === 'user',
  };
}

function validateWorkflowYaml(yaml: string): WorkflowValidateResponse {
  const result = parseWorkflowYaml(yaml);
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: result.error.issues.length
        ? result.error.issues
        : [{ path: '(root)', message: result.error.message }],
    };
  }
  return {
    ok: true,
    parsed: result.workflow,
    graph: workflowToGraph(result.workflow),
    diagnostics: [],
  };
}

function requiredInputsMissing(
  workflow: ParsedWorkflow,
  inputs: Record<string, unknown>,
): string[] {
  return Object.entries(workflow.inputs ?? {})
    .filter(([, def]) => def.required === true)
    .map(([name]) => name)
    .filter((name) => inputs[name] === undefined || inputs[name] === null || inputs[name] === '');
}

function issueMessages(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}
