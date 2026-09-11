import type { AgentTemplate } from '@funny/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ModelSelect, ModeSelect, TemplateSelect } from '@/components/PromptSelectors';
import { BranchPicker, SearchablePicker } from '@/components/SearchablePicker';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('@/components/ProviderSetupDialog', () => ({
  ProviderSetupDialog: ({ label }: { label: string }) => (
    <div role="dialog" aria-label={`Setup ${label}`} />
  ),
}));

const virtualizer = vi.hoisted(() => ({ heights: [] as number[] }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const size = estimateSize();
    virtualizer.heights.push(size);
    return {
      measure: vi.fn(),
      scrollToIndex: vi.fn(),
      getTotalSize: () => count * size,
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({ index, size, start: index * size })),
    };
  },
}));

let viewport = 390;
const listeners = new Set<() => void>();
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);
function resize(width: number) {
  act(() => {
    viewport = width;
    listeners.forEach((listener) => listener());
  });
}
beforeEach(() => {
  // jsdom has no layout/scroll implementation; Radix Select uses this on open.
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  viewport = 390;
  virtualizer.heights.length = 0;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(max-width: 767px)' && viewport < 768;
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
});
afterEach(() => {
  cleanup();
  listeners.clear();
  vi.unstubAllGlobals();
  if (originalScrollIntoView)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

const modes = [
  { value: 'ask', label: 'Ask' },
  { value: 'auto', label: 'Auto' },
];
const modelGroups = [
  {
    provider: 'codex',
    providerLabel: 'Codex',
    models: [{ value: 'codex:gpt-5.5', label: 'GPT-5.5' }],
  },
];

async function openModel() {
  fireEvent.click(screen.getByTestId('prompt-model-select'));
  return screen.findByRole('dialog', { name: 'Model' });
}

describe('mobile prompt selectors', () => {
  test('desktop mode and template selectors retain their combobox presentation', async () => {
    resize(768);
    render(
      <>
        <ModeSelect value="ask" modes={modes} onChange={vi.fn()} />
        <TemplateSelect value={undefined} templates={[]} onChange={vi.fn()} />
      </>,
    );
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    fireEvent.keyDown(screen.getByTestId('prompt-mode-select'), { key: 'ArrowDown' });
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-selection-drawer')).not.toBeInTheDocument();
  });

  test('canceling effort discards the pending model on reopening', async () => {
    const onChange = vi.fn();
    const onEffortChange = vi.fn();
    render(
      <ModelSelect
        value="codex:gpt-5.5"
        effort="high"
        groups={modelGroups}
        onChange={onChange}
        onEffortChange={onEffortChange}
      />,
    );
    await openModel();
    fireEvent.click(screen.getByTestId('prompt-model-option-codex:gpt-5.5'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await openModel();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(onEffortChange).not.toHaveBeenCalled();
  });

  test('branch creation remains available when search has no matching branches', async () => {
    render(
      <BranchPicker
        mobilePresentation="drawer"
        showCreateNew
        showCopy={false}
        branches={['main']}
        selected="main"
        onChange={vi.fn()}
        testId="branch"
      />,
    );
    fireEvent.click(screen.getByTestId('branch'));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'missing' } });
    expect(screen.getByText('No branches match')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create new branch' })).toBeInTheDocument();
  });

  test('mode commits once, closes and restores trigger focus', async () => {
    const onChange = vi.fn();
    render(<ModeSelect value="ask" modes={modes} onChange={onChange} />);
    const trigger = screen.getByTestId('prompt-mode-select');
    fireEvent.click(trigger);
    const drawer = await screen.findByRole('dialog', { name: 'Mode' });
    expect(within(drawer).getByRole('button', { name: 'Ask' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(drawer).getByRole('button', { name: 'Auto' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('auto');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  test('Close and Escape cancel without a selection', async () => {
    const onChange = vi.fn();
    render(<ModeSelect value="ask" modes={modes} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('prompt-mode-select'));
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId('prompt-mode-select'));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
  });

  test('model effort is staged, Back discards it and completion commits both values once', async () => {
    const onChange = vi.fn();
    const onEffortChange = vi.fn();
    render(
      <ModelSelect
        value="codex:gpt-5.5"
        effort="high"
        groups={modelGroups}
        onChange={onChange}
        onEffortChange={onEffortChange}
      />,
    );
    await openModel();
    fireEvent.click(screen.getByTestId('prompt-model-option-codex:gpt-5.5'));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: 'Model' })).toBeInTheDocument();
    expect(onEffortChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('prompt-model-option-codex:gpt-5.5'));
    fireEvent.click(screen.getByTestId('prompt-effort-option-codex:gpt-5.5-high'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('codex:gpt-5.5');
    expect(onEffortChange).toHaveBeenCalledExactlyOnceWith('high');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('resizing at the breakpoint discards pending effort and keeps desktop menus', async () => {
    const onChange = vi.fn();
    const onEffortChange = vi.fn();
    resize(767);
    render(
      <ModelSelect
        value="codex:gpt-5.5"
        effort="high"
        groups={modelGroups}
        onChange={onChange}
        onEffortChange={onEffortChange}
      />,
    );
    await openModel();
    fireEvent.click(screen.getByTestId('prompt-model-option-codex:gpt-5.5'));
    resize(768);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('prompt-model-select'), { key: 'ArrowDown' });
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    resize(390);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await openModel();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(onEffortChange).not.toHaveBeenCalled();
  });

  test('models without an effort callback commit immediately and unavailable models stay disabled', async () => {
    const onChange = vi.fn();
    render(
      <ModelSelect
        value="codex:gpt-5.5"
        groups={[
          ...modelGroups,
          {
            provider: 'other',
            providerLabel: 'Other',
            disabled: true,
            disabledReason: 'no-runner',
            models: [{ value: 'other:model', label: 'Unavailable' }],
          },
        ]}
        onChange={onChange}
      />,
    );
    const drawer = await openModel();
    expect(within(drawer).getByText('Connect a runner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unavailable' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('prompt-model-option-codex:gpt-5.5'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('codex:gpt-5.5');
  });

  test('provider setup closes the selection panel', async () => {
    render(<ModelSelect value="codex:gpt-5.5" groups={modelGroups} onChange={vi.fn()} />);
    await openModel();
    fireEvent.click(screen.getByRole('button', { name: 'Configure provider…' }));
    expect(await screen.findByRole('dialog', { name: 'Setup Codex' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Model' })).not.toBeInTheDocument(),
    );
  });

  test('template grouping, selection and clearing preserve existing values', async () => {
    const templates = [
      { id: 'mine', name: 'Personal' },
      { id: 'team', name: 'Team', shared: true },
      { id: '__builtin__review', name: 'Review' },
    ] as AgentTemplate[];
    const onChange = vi.fn();
    render(<TemplateSelect value="mine" templates={templates} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('prompt-template-select'));
    const drawer = await screen.findByRole('dialog', { name: 'Template' });
    for (const label of ['My templates', 'Shared', 'Built-in'])
      expect(within(drawer).getByRole('region', { name: label })).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Team' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('team');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId('prompt-template-select'));
    fireEvent.click(await screen.findByRole('button', { name: 'No template' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  test('branch drawer does not autofocus search and preserves filtering, copy and 48px virtual rows', async () => {
    const onChange = vi.fn();
    render(
      <TooltipProvider>
        <BranchPicker
          mobilePresentation="drawer"
          branches={['main', 'develop']}
          selected="main"
          onChange={onChange}
          testId="branch"
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId('branch'));
    const drawer = await screen.findByRole('dialog', { name: 'Base branch' });
    const input = within(drawer).getByRole('textbox');
    expect(input).not.toHaveFocus();
    expect(virtualizer.heights.at(-1)).toBe(48);
    expect(within(drawer).getByRole('button', { name: 'Copy main' })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'missing' } });
    expect(screen.getByText('No branches match')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'develop' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'develop' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('develop');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('branch creation retains its existing input and confirmation flow', async () => {
    const onChange = vi.fn();
    render(
      <BranchPicker
        mobilePresentation="drawer"
        showCreateNew
        showCopy={false}
        branches={['main']}
        selected="main"
        onChange={onChange}
        testId="branch"
      />,
    );
    fireEvent.click(screen.getByTestId('branch'));
    fireEvent.click(await screen.findByRole('button', { name: 'Create new branch' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('branch-new-input'), {
      target: { value: 'feature mobile' },
    });
    fireEvent.click(screen.getByTestId('branch-new-confirm'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('feature-mobile');
  });

  test('shared pickers outside prompt retain popover autofocus on mobile', async () => {
    render(
      <SearchablePicker
        label="Branch"
        displayValue="main"
        items={[]}
        searchPlaceholder="Search"
        noMatchText="No matches"
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'main' }));
    const input = await screen.findByRole('textbox');
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.queryByTestId('prompt-selection-drawer')).not.toBeInTheDocument();
    expect(virtualizer.heights.at(-1)).toBe(32);
  });

  test('drawer can close inside a prompt dialog while leaving the parent open', async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>New thread</DialogTitle>
          <ModeSelect value="ask" modes={modes} onChange={vi.fn()} />
        </DialogContent>
      </Dialog>,
    );
    fireEvent.click(screen.getByTestId('prompt-mode-select'));
    const drawer = await screen.findByRole('dialog', { name: 'Mode' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Mode' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('dialog', { name: 'New thread' })).toBeInTheDocument();
  });
});
