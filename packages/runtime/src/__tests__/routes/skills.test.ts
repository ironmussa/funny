import { Hono } from 'hono';
import { okAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const {
  mockListSkills,
  mockListProjectSkills,
  mockListProjectCommands,
  mockListDirectClaudeSkills,
  mockListPluginCommands,
  mockAddSkill,
  mockRemoveSkill,
  mockResolveAgentResources,
  MOCK_RECOMMENDED,
} = vi.hoisted(() => ({
  mockListSkills: vi.fn(),
  mockListProjectSkills: vi.fn(),
  mockListProjectCommands: vi.fn(),
  mockListDirectClaudeSkills: vi.fn(),
  mockListPluginCommands: vi.fn(),
  mockAddSkill: vi.fn(),
  mockRemoveSkill: vi.fn(),
  mockResolveAgentResources: vi.fn(),
  MOCK_RECOMMENDED: [
    {
      name: 'find-skills',
      description: 'Find skills',
      identifier: 'vercel-labs/skills@find-skills',
    },
  ],
}));

vi.mock('../../services/skills-service.js', () => ({
  listSkills: mockListSkills,
  listProjectSkills: mockListProjectSkills,
  listProjectCommands: mockListProjectCommands,
  listDirectClaudeSkills: mockListDirectClaudeSkills,
  listPluginCommands: mockListPluginCommands,
  addSkill: mockAddSkill,
  removeSkill: mockRemoveSkill,
  RECOMMENDED_SKILLS: MOCK_RECOMMENDED,
}));

vi.mock('../../services/agent-resources/resolver.js', () => ({
  resolveAgentResources: mockResolveAgentResources,
}));

// Bypass path-scope authorization in unit tests — it requires a running
// RuntimeServiceProvider which is covered in integration tests.
vi.mock('../../utils/path-scope.js', () => ({
  requireProjectPath: vi.fn(async () => null),
  requirePickerPath: vi.fn(async () => null),
  isUnder: vi.fn(() => true),
}));

import skillsApp from '../../routes/skills.js';

describe('Skills Routes', () => {
  let app: Hono;

  beforeEach(() => {
    mockListSkills.mockReset();
    mockListProjectSkills.mockReset();
    mockListProjectCommands.mockReset();
    mockListDirectClaudeSkills.mockReset();
    mockListPluginCommands.mockReset();
    mockRemoveSkill.mockReset();

    mockListSkills.mockReturnValue([
      { name: 'test-skill', description: 'A test skill', source: 'github', scope: 'global' },
    ]);
    mockListProjectSkills.mockReturnValue([]);
    mockListProjectCommands.mockReturnValue([]);
    mockListDirectClaudeSkills.mockReturnValue([]);
    mockListPluginCommands.mockReturnValue([]);
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

  test('GET /skills with projectPath includes project slash commands first', async () => {
    mockListProjectCommands.mockReturnValue([
      { name: 'opsx:apply', description: 'Apply change', source: 'project', scope: 'project' },
    ]);

    const res = await app.request('/skills?projectPath=/tmp/project');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills[0].name).toBe('opsx:apply');
    expect(mockListProjectCommands).toHaveBeenCalledWith('/tmp/project');
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

  describe('GET /skills/resources', () => {
    beforeEach(() => {
      mockResolveAgentResources.mockReset();
      mockResolveAgentResources.mockReturnValue(
        okAsync({ provider: 'codex', resources: [], hidden: [] }),
      );
    });

    test('defaults provider=claude and phase=composer', async () => {
      const res = await app.request('/skills/resources');
      expect(res.status).toBe(200);
      expect(mockResolveAgentResources).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'claude', phase: 'composer' }),
      );
    });

    test('passes provider, model, phase, and projectPath through to the resolver', async () => {
      const res = await app.request(
        '/skills/resources?provider=codex&model=gpt-5.5&phase=settings&projectPath=/tmp/p',
      );
      expect(res.status).toBe(200);
      expect(mockResolveAgentResources).toHaveBeenCalledWith({
        provider: 'codex',
        model: 'gpt-5.5',
        phase: 'settings',
        projectPath: '/tmp/p',
      });
    });

    test('rejects an invalid phase by falling back to composer', async () => {
      await app.request('/skills/resources?phase=bogus');
      expect(mockResolveAgentResources).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'composer' }),
      );
    });
  });
});
