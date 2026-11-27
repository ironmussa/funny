import { describe, expect, test, vi, mock } from 'bun:test';

import { act, fireEvent, screen } from '@testing-library/react';

import { PromptToolbar } from '@/components/prompt-input/PromptToolbar';
import { ModelSelect } from '@/components/PromptInputUI';

import { renderWithProviders } from '../helpers/render';

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('ModelSelect', () => {
  test('shows the provider in the selected model trigger', () => {
    renderWithProviders(
      <ModelSelect
        value="codex:gpt-5.5"
        effort="high"
        onChange={vi.fn()}
        onEffortChange={vi.fn()}
        groups={[
          {
            provider: 'codex',
            providerLabel: 'Codex',
            models: [{ value: 'codex:gpt-5.5', label: 'GPT-5.5' }],
          },
        ]}
      />,
    );

    const trigger = screen.getByTestId('prompt-model-select');
    expect(trigger).toHaveTextContent(/Codex\s*·\s*GPT-5\.5\s*·\s*High/);
    expect(trigger).toHaveClass('shrink-0', 'whitespace-nowrap');
    expect(screen.getByText('· High')).toHaveClass('shrink-0');
  });

  test('keeps toolbar selectors scrollable independently of the pinned action buttons', () => {
    renderWithProviders(
      <PromptToolbar
        unifiedModel="claude:opus"
        effort="medium"
        onUnifiedModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        modelGroups={[
          {
            provider: 'claude',
            providerLabel: 'Claude',
            models: [{ value: 'claude:opus', label: 'Opus 4.7' }],
          },
        ]}
        showTemplates={false}
        templates={[]}
        onTemplateChange={vi.fn()}
        mode="autoEdit"
        onModeChange={vi.fn()}
        modes={[{ value: 'autoEdit', label: 'Auto Edit' }]}
        showBacklog={true}
        sendToBacklog={false}
        onAttach={vi.fn()}
        hasDictation={false}
        isRecording={false}
        isTranscribing={false}
        loading={false}
        running={false}
        editorEmpty={true}
        isQueueMode={false}
        onSend={vi.fn()}
      />,
    );

    const selectors = screen.getByTestId('prompt-toolbar-selectors');
    expect(selectors).toHaveClass('md:min-w-0', 'md:flex-1', 'md:overflow-x-auto');
    expect(selectors).toContainElement(screen.getByTestId('prompt-model-select'));
    expect(selectors).toContainElement(screen.getByTestId('prompt-mode-select'));
    expect(selectors).toContainElement(screen.getByTestId('prompt-backlog-toggle'));
    expect(screen.getByTestId('prompt-mode-select')).toHaveClass('shrink-0', 'whitespace-nowrap');
    // Action buttons sit outside the horizontal scroll container so they stay visible.
    expect(selectors).not.toContainElement(screen.getByTestId('prompt-attach'));
    expect(selectors).not.toContainElement(screen.getByTestId('prompt-send'));
  });
});

test('model menu scrolls within available height and effort selection escapes its scroll container', async () => {
  const onChange = vi.fn();
  const onEffortChange = vi.fn();
  renderWithProviders(
    <ModelSelect
      value="codex:gpt-5.5"
      effort="high"
      onChange={onChange}
      onEffortChange={onEffortChange}
      groups={[
        {
          provider: 'codex',
          providerLabel: 'Codex',
          models: [{ value: 'codex:gpt-5.5', label: 'GPT-5.5' }],
        },
      ]}
    />,
  );

  fireEvent.keyDown(screen.getByTestId('prompt-model-select'), { key: 'ArrowDown' });
  const menu = await screen.findByRole('menu');
  // jsdom has no layout: verify the viewport constraint, then exercise the
  // portaled submenu so adding overflow cannot silently clip effort choices.
  expect(menu).toHaveClass(
    'max-h-[var(--radix-dropdown-menu-content-available-height)]',
    'overflow-y-auto',
    'overscroll-contain',
  );
  // Models live under their provider's submenu.
  const provider = screen.getByTestId('prompt-provider-option-codex');
  act(() => provider.focus());
  fireEvent.keyDown(provider, { key: 'ArrowRight' });
  const model = await screen.findByTestId('prompt-model-option-codex:gpt-5.5');
  expect(menu).not.toContainElement(model);
  act(() => model.focus());
  fireEvent.keyDown(model, { key: 'ArrowRight' });
  const effort = await screen.findByTestId('prompt-effort-option-codex:gpt-5.5-high');
  expect(menu).not.toContainElement(effort);
  expect(effort.closest('[role="menu"]')).toHaveClass(
    'max-h-[var(--radix-dropdown-menu-content-available-height)]',
    'overflow-y-auto',
  );
  fireEvent.click(effort);
  expect(onChange).toHaveBeenCalledWith('codex:gpt-5.5');
  expect(onEffortChange).toHaveBeenCalledWith('high');
});
