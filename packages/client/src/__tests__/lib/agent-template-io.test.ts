import type { AgentTemplate } from '@funny/shared';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { exportTemplate, parseTemplateFromJson } from '@/lib/agent-template-io';

function makeTemplate(overrides: Partial<AgentTemplate> = {}): AgentTemplate {
  return {
    id: 'tpl-1',
    userId: 'u-1',
    name: 'My Template',
    description: 'desc',
    icon: 'bot',
    color: 'blue',
    model: 'sonnet',
    systemPromptMode: 'append',
    systemPrompt: 'Be helpful',
    disallowedTools: [],
    mcpServers: [],
    builtinSkillsDisabled: false,
    customSkillPaths: [],
    agentName: 'helper',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AgentTemplate;
}

describe('parseTemplateFromJson', () => {
  test('parses a valid v1 export file', () => {
    const json = JSON.stringify({
      version: 1,
      template: { name: 'Reviewer', model: 'sonnet' },
    });

    expect(parseTemplateFromJson(json)).toEqual({ name: 'Reviewer', model: 'sonnet' });
  });

  test('returns error strings for invalid payloads', () => {
    expect(parseTemplateFromJson('not json')).toBe('Invalid JSON file');
    expect(parseTemplateFromJson('null')).toBe('Invalid template file format');
    expect(parseTemplateFromJson(JSON.stringify({ version: 2, template: { name: 'x' } }))).toBe(
      'Unsupported template version',
    );
    expect(parseTemplateFromJson(JSON.stringify({ version: 1 }))).toBe('Missing template data');
    expect(parseTemplateFromJson(JSON.stringify({ version: 1, template: {} }))).toBe(
      'Template must have a name',
    );
  });
});

describe('exportTemplate', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  test('downloads sanitized JSON for the template', () => {
    const click = vi.fn();
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement;
    const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    exportTemplate(makeTemplate({ name: 'My Cool Template!' }));

    expect(createElementSpy).toHaveBeenCalledWith('a');
    expect(anchor.download).toBe('My_Cool_Template_.agent-template.json');
    expect(click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });
});
