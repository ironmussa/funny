import { Hono } from 'hono';
import {
  listSkills,
  addSkill,
  removeSkill,
  RECOMMENDED_SKILLS,
} from '../services/skills-service.js';

const app = new Hono();

// List installed skills
app.get('/', (c) => {
  try {
    const skills = listSkills();
    return c.json({ skills });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Install a skill
app.post('/', async (c) => {
  const { identifier } = await c.req.json<{ identifier: string }>();

  if (!identifier) {
    return c.json({ error: 'identifier is required (e.g. owner/repo@skill-name)' }, 400);
  }

  try {
    await addSkill(identifier);
    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Remove a skill
app.delete('/:name', (c) => {
  const name = c.req.param('name');

  try {
    removeSkill(name);
    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get recommended skills
app.get('/recommended', (c) => {
  return c.json({ skills: RECOMMENDED_SKILLS });
});

export default app;
