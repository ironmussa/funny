import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { ToolCallCard } from '@/components/ToolCallCard';
import { ToolCallGroup } from '@/components/ToolCallGroup';

import { renderWithProviders } from '../helpers/render';

describe('Subagent tool calls', () => {
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
