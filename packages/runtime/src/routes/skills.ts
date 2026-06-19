/**
 * @domain subdomain: Extensions
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: SkillsService
 */

import type { ResourcePhase } from '@funny/shared';
import { Hono } from 'hono';

import { resolveAgentResources } from '../services/agent-resources/resolver.js';
import {
  listSkills,
  listProjectSkills,
  listProjectCommands,
  listDirectClaudeSkills,
  listPluginCommands,
  addSkill,
  removeSkill,
  RECOMMENDED_SKILLS,
} from '../services/skills-service.js';
import type { HonoEnv } from '../types/hono-env.js';
import { requireProjectPath } from '../utils/path-scope.js';
import { resultToResponse } from '../utils/result-response.js';
import { addSkillSchema, validate } from '../validation/schemas.js';

const app = new Hono<HonoEnv>();

const VALID_PHASES: ResourcePhase[] = ['settings', 'composer', 'runtime'];

// Provider-scoped Agent Resources. Unlike `/` (legacy, Claude-shaped, returns a
// flat Skill[]), this resolves skills, slash commands, and MCP by the EFFECTIVE
// provider so Codex/Gemini/etc. never see Claude `.claude` resources. Built-in /
// session commands are merged client-side (the composer already holds them from
// `agent:init`), so this endpoint covers filesystem + MCP resolution.
app.get('/resources', async (c) => {
  const provider = c.req.query('provider') || 'claude';
  const model = c.req.query('model') || undefined;
  const phaseParam = c.req.query('phase');
  const phase: ResourcePhase = VALID_PHASES.includes(phaseParam as ResourcePhase)
    ? (phaseParam as ResourcePhase)
    : 'composer';
  const projectPath = c.req.query('projectPath');
  if (projectPath) {
    const denied = await requireProjectPath(projectPath, c.get('userId'));
    if (denied) return denied;
  }

  const result = await resolveAgentResources({ provider, model, phase, projectPath });
  if (result.isErr()) return resultToResponse(c, result);
  return c.json(result.value);
});

// List installed skills (optionally include project-level skills)
app.get('/', async (c) => {
  const lockFileSkills = listSkills();
  const lockFileNames = new Set(lockFileSkills.map((s) => s.name));
  const directSkills = listDirectClaudeSkills(lockFileNames);
  const pluginCommands = listPluginCommands();
  const projectPath = c.req.query('projectPath');
  if (projectPath) {
    const denied = await requireProjectPath(projectPath, c.get('userId'));
    if (denied) return denied;
  }
  const projectSkills = projectPath ? listProjectSkills(projectPath) : [];
  const projectCommands = projectPath ? listProjectCommands(projectPath) : [];

  // Deduplicate by name (project > plugin > direct > lock file)
  const seen = new Set<string>();
  const all = [
    ...projectCommands,
    ...projectSkills,
    ...pluginCommands,
    ...directSkills,
    ...lockFileSkills,
  ];
  const deduped = all.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });

  return c.json({ skills: deduped });
});

// Install a skill
app.post('/', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(addSkillSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await addSkill(parsed.value.identifier);
  if (result?.isErr?.()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// Remove a skill
app.delete('/:name', (c) => {
  const name = c.req.param('name');
  removeSkill(name);
  return c.json({ ok: true });
});

// Get recommended skills
app.get('/recommended', (c) => {
  return c.json({ skills: RECOMMENDED_SKILLS });
});

export default app;
