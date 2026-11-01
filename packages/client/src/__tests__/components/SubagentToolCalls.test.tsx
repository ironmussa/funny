import { fireEvent, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, test } from 'vitest';

import { ToolCallCard } from '@/components/ToolCallCard';
import { ToolCallGroup } from '@/components/ToolCallGroup';

import { renderWithProviders } from '../helpers/render';

describe('Subagent tool calls', () => {
  beforeAll(async () => {
    // Load the lazy renderer before assertions use Testing Library's short timeout.
    await import('react-markdown');
  });

  test.each(['Task', 'Agent'])(
    '%s parses the tools-used header before rendering Markdown',
    async (name) => {
      const report =
        '<tools-used-before-summary>WebFetch</tools-used-before-summary>\n**Sandbox report**';
      renderWithProviders(
        <ToolCallCard
          name={name}
          input={{ description: 'Read sandbox docs' }}
          output={name === 'Task' ? JSON.stringify([{ type: 'text', text: report }]) : report}
        />,
      );
      fireEvent.click(screen.getByTestId('task-card-toggle'));
      expect(screen.getByText('WebFetch')).toBeInTheDocument();
      expect(await screen.findByText('Sandbox report', { selector: 'strong' })).toBeInTheDocument();
      expect(screen.getByTestId('task-card')).not.toHaveTextContent('tools-used-before-summary');
    },
  );

  test('a metadata-only completed result does not show a running indicator', () => {
    renderWithProviders(
      <ToolCallCard
        name="Agent"
        input={{ description: 'Read sandbox docs' }}
        output="<tools-used-before-summary>WebFetch</tools-used-before-summary>"
      />,
    );
    fireEvent.click(screen.getByTestId('task-card-toggle'));
    expect(screen.getByText('WebFetch')).toBeInTheDocument();
    expect(screen.getByTestId('task-card').querySelector('.animate-spin')).toBeNull();
  });

  test.each([
    'Report mentioning <tools-used-before-summary>WebFetch</tools-used-before-summary>',
    '<tools-used-before-summary>WebFetch',
  ])('preserves report content and incomplete headers: %s', async (output) => {
    renderWithProviders(
      <ToolCallCard name="Agent" input={{ description: 'Read sandbox docs' }} output={output} />,
    );
    fireEvent.click(screen.getByTestId('task-card-toggle'));
    expect(await screen.findByText(output)).toBeInTheDocument();
  });

  test.each(['Task', 'Agent'])('%s expands grouped commands and their output', (name) => {
    renderWithProviders(
      <ToolCallCard
        name={name}
        input={{ description: 'Inspect dependencies' }}
        childToolCalls={[
          { id: 'first', name: 'Bash', input: { command: 'echo first' }, output: 'First result' },
          {
            id: 'second',
            name: 'Bash',
            input: { command: 'echo second' },
            output: 'Second result',
          },
        ]}
      />,
    );

    const group = screen.getByRole('button', { name: /Run Command.*×2/ });
    expect(group).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: /echo first/ }));
    expect(screen.getByText('First result')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /echo second/ }));
    expect(screen.getByText('Second result')).toBeInTheDocument();
    fireEvent.click(group);
    expect(screen.queryByText('First result')).not.toBeInTheDocument();
  });

  test.each(['Task', 'Agent'])(
    '%s keeps agent icons in groups and cards with hidden labels',
    (name) => {
      const call = { id: 'agent', name, input: { description: 'Inspect dependencies' } };
      renderWithProviders(
        <ToolCallGroup
          name={name}
          calls={[call]}
          renderCall={(item) => <ToolCallCard {...item} hideLabel />}
        />,
      );
      const group = screen.getByRole('button', { name: /Subagent/ });
      expect(group.querySelector('.lucide-bot')).toBeInTheDocument();
      fireEvent.click(group);
      const card = screen.getByTestId('task-card');
      expect(
        within(card).getByTestId('task-card-toggle').querySelector('.lucide-bot'),
      ).toBeInTheDocument();
    },
  );
});
