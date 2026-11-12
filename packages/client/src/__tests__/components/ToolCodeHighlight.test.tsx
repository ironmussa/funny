import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { BackgroundCard } from '@/components/tool-cards/BackgroundCard';
import { codeFieldLanguage } from '@/components/tool-cards/code-input';
import { GenericToolCard } from '@/components/tool-cards/GenericToolCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('codeFieldLanguage', () => {
  test('maps code-holding fields of built-in tools to a language', () => {
    expect(codeFieldLanguage('Monitor', 'command', {})).toBe('bash');
    expect(codeFieldLanguage('NotebookEdit', 'new_source', {})).toBe('python');
    expect(codeFieldLanguage('NotebookEdit', 'new_source', { cell_type: 'markdown' })).toBe(
      'markdown',
    );
    expect(codeFieldLanguage('apply_patch', 'input', {})).toBe('diff');
    expect(codeFieldLanguage('ApplyPatch', 'input', {})).toBe('diff');
  });

  test('leaves plain fields alone', () => {
    expect(codeFieldLanguage('Monitor', 'description', {})).toBeNull();
    expect(codeFieldLanguage('Grep', 'pattern', {})).toBeNull();
    expect(codeFieldLanguage('Skill', 'code', {})).toBeNull();
  });
});

describe('GenericToolCard code fields', () => {
  test('highlights a command field as bash', async () => {
    const { container } = render(
      <GenericToolCard
        name="Monitor"
        parsed={{ description: 'watch build', command: 'tail -f build.log | grep error' }}
        label="Monitor"
        displayTime={null}
        summary="watch build"
        filePath={null}
        displayPath={null}
        isTodo={false}
        todos={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand Monitor' }));

    await waitFor(() => expect(container.querySelector('code.language-bash')).not.toBeNull());
    expect(container.querySelector('code.language-bash')?.textContent).toBe(
      'tail -f build.log | grep error',
    );
  });
});

describe('BackgroundCard', () => {
  const parsed = {
    jobId: 'job-1',
    label: 'check test',
    command: "bun run test --filter 'clone'",
    cwd: '/repo',
    status: 'failed',
    exitCode: 1,
  };

  test('shows the label, status and exit code in the header', () => {
    render(<BackgroundCard parsed={parsed} output="Tests: 1 failed" />);

    expect(screen.getByText('check test')).toBeInTheDocument();
    expect(screen.getByTestId('background-card-status')).toHaveTextContent('failed');
    expect(screen.getByTestId('background-card-status')).toHaveTextContent('1');
  });

  test('highlights the command as bash and shows the output when expanded', async () => {
    const { container } = render(<BackgroundCard parsed={parsed} output="Tests: 1 failed" />);

    fireEvent.click(screen.getByTestId('background-card-toggle'));

    await waitFor(() => expect(container.querySelector('code.language-bash')).not.toBeNull());
    expect(container.querySelector('code.language-bash')?.textContent).toBe(parsed.command);
    expect(screen.getByText('Tests: 1 failed')).toBeInTheDocument();
    expect(screen.getByText('/repo')).toBeInTheDocument();
  });
});
