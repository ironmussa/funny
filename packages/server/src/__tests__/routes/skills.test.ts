import { describe, test, expect, mock, beforeEach } from 'bun:test';

import { Hono } from 'hono';

const mockListSkills = mock(() => [
  { name: 'test-skill', description: 'A test skill', source: 'github', scope: 'global' },
]);
const mockListProjectSkills = mock(() => []);
const mockAddSkill = mock(async () => {});
const mockRemoveSkill = mock(() => {});
const MOCK_RECOMMENDED = [
  { name: 'find-skills', description: 'Find skills', identifier: 'vercel-labs/skills@find-skills' },
];

mock.module('../../services/skills-service.js', () => ({
  listSkills: mockListSkills,
  listProjectSkills: mockListProjectSkills,
  addSkill: mockAddSkill,
  removeSkill: mockRemoveSkill,
  RECOMMENDED_SKILLS: MOCK_RECOMMENDED,
}));

import skillsApp from '../../routes/skills.js';

describe('Skills Routes', () => {
  let app: Hono;

  beforeEach(() => {
    mockListSkills.mockReset();
    mockListProjectSkills.mockReset();
    mockAddSkill.mockReset();
    mockRemoveSkill.mockReset();

    mockListSkills.mockReturnValue([
      { name: 'test-skill', description: 'A test skill', source: 'github', scope: 'global' },
    ]);
    mockListProjectSkills.mockReturnValue([]);
    mockAddSkill.mockImplementation(async () => {});
    mockRemoveSkill.mockImplementation(() => {});

    app = new Hono();
    app.route('/skills', skillsApp);
  });

  test('GET /skills returns global skills', async () => {
    const res = await app.request('/skills');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0].name).toBe('test-skill');
  });

  test('GET /skills with projectPath includes project skills', async () => {
    mockListProjectSkills.mockReturnValue([
      { name: 'project-skill', description: 'Project-level', source: 'project', scope: 'project' },
    ]);
    const res = await app.request('/skills?projectPath=/tmp/project');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills).toHaveLength(2);
  });

  test('POST /skills installs a skill', async () => {
    const res = await app.request('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'vercel-labs/skills@find-skills' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockAddSkill).toHaveBeenCalledWith('vercel-labs/skills@find-skills');
  });

  test('DELETE /skills/:name removes a skill', async () => {
    const res = await app.request('/skills/test-skill', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockRemoveSkill).toHaveBeenCalledWith('test-skill');
  });

  test('GET /skills/recommended returns recommended skills', async () => {
    const res = await app.request('/skills/recommended');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills).toEqual(MOCK_RECOMMENDED);
  });
});
