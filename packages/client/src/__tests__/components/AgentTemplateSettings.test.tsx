import type { AgentTemplate } from '@funny/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { AgentTemplateSettings } from '@/components/settings/AgentTemplateSettings';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useAuthStore } from '@/stores/auth-store';

const template: AgentTemplate = {
  id: 'template-1',
  userId: 'user-1',
  name: 'Review assistant',
  description: 'Reviews changes before merge',
  color: '#7CB9E8',
  systemPromptMode: 'prepend',
  systemPrompt: 'Review {{TARGET}} carefully.',
  variables: [{ name: 'TARGET', description: 'Code to review' }],
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
};

describe('AgentTemplateSettings accessibility', () => {
  const duplicateTemplate = vi.fn(async () => null);

  beforeEach(() => {
    duplicateTemplate.mockClear();
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    useAgentTemplateStore.setState({
      templates: [template],
      usageStats: { [template.id]: 2 },
      initialized: true,
      duplicateTemplate,
    });
  });

  test('exposes separate named actions without nesting interactive controls', () => {
    render(<AgentTemplateSettings />);

    const card = screen.getByTestId('agent-template-card-template-1');
    expect(card).not.toHaveAttribute('role', 'button');
    expect(screen.getByRole('button', { name: 'Edit Review assistant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Review assistant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Duplicate Review assistant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Review assistant' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Review assistant' }));

    expect(duplicateTemplate).toHaveBeenCalledWith(template.id);
    expect(screen.queryByText('Edit Template')).not.toBeInTheDocument();
  });

  test('associates editor labels with their controls', () => {
    render(<AgentTemplateSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Review assistant' }));

    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sharing' }));

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Review assistant');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(
      'Reviews changes before merge',
    );
    expect(screen.getByRole('combobox', { name: 'Default Model' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(
      'Review {{TARGET}} carefully.',
    );
    expect(screen.getByRole('checkbox', { name: 'read_file' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Shared' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Variable 1 name' })).toHaveValue('TARGET');
  });
});
