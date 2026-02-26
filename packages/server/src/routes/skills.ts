import { Hono } from 'hono';

import {
  listSkills,
  listProjectSkills,
  addSkill,
  removeSkill,
  RECOMMENDED_SKILLS,
} from '../services/skills-service.js';
import { resultToResponse } from '../utils/result-response.js';
import { addSkillSchema, validate } from '../validation/schemas.js';

const app = new Hono();

// List installed skills (optionally include project-level skills)
app.get('/', (c) => {
  const globalSkills = listSkills();
  const projectPath = c.req.query('projectPath');
  const projectSkills = projectPath ? listProjectSkills(projectPath) : [];
  return c.json({ skills: [...projectSkills, ...globalSkills] });
});

// Install a skill
app.post('/', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(addSkillSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  await addSkill(parsed.value.identifier);
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
