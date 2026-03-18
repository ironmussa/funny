/**
 * @domain subdomain: Extensions
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: SkillsService
 */

import { Hono } from 'hono';

import {
  listSkills,
  listProjectSkills,
  listDirectClaudeSkills,
  listPluginCommands,
  addSkill,
  removeSkill,
  RECOMMENDED_SKILLS,
} from '../services/skills-service.js';
import { resultToResponse } from '../utils/result-response.js';
import { addSkillSchema, validate } from '../validation/schemas.js';

const app = new Hono();

// List installed skills (optionally include project-level skills)
app.get('/', (c) => {
  const lockFileSkills = listSkills();
  const lockFileNames = new Set(lockFileSkills.map((s) => s.name));
  const directSkills = listDirectClaudeSkills(lockFileNames);
  const pluginCommands = listPluginCommands();
  const projectPath = c.req.query('projectPath');
  const projectSkills = projectPath ? listProjectSkills(projectPath) : [];

  // Deduplicate by name (project > plugin > direct > lock file)
  const seen = new Set<string>();
  const all = [...projectSkills, ...pluginCommands, ...directSkills, ...lockFileSkills];
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

  try {
    await addSkill(parsed.value.identifier);
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to install skill' }, 500);
  }
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
