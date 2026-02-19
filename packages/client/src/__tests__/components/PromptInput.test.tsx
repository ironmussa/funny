import { describe, test, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../helpers/render';
import { PromptInput } from '@/components/PromptInput';
import { useAppStore } from '@/stores/app-store';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    listBranches: vi.fn().mockResolvedValue({ branches: [], defaultBranch: 'main' }),
    listWorktrees: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue({ skills: [] }),
  },
}));

vi.mock('@/components/ImageLightbox', () => ({
  ImageLightbox: () => null,
}));

// ── Setup ───────────────────────────────────────────────────────

beforeEach(() => {
  useAppStore.setState({
    projects: [{ id: 'p1', name: 'Test', path: '/tmp/test', userId: '__local__', createdAt: '', sortOrder: 0 }],
    selectedProjectId: 'p1',
    selectedThreadId: null,
    activeThread: null,
  });
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────

describe('PromptInput', () => {
  test('Enter key triggers onSubmit with prompt text', () => {
    const onSubmit = vi.fn();
    renderWithProviders(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Hello agent' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      'Hello agent',
      expect.objectContaining({ model: 'opus', mode: 'autoEdit' }),
      undefined
    );
  });

  test('Shift+Enter does not trigger submit', () => {
    const onSubmit = vi.fn();
    renderWithProviders(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'line1' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('empty prompt cannot be submitted', () => {
    const onSubmit = vi.fn();
    renderWithProviders(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('stop button shown when running=true, send button when not', () => {
    const onStop = vi.fn();

    // Running state — stop button visible
    const { unmount } = renderWithProviders(
      <PromptInput onSubmit={vi.fn()} onStop={onStop} running={true} />
    );
    expect(screen.getAllByTitle('prompt.stopAgent').length).toBeGreaterThan(0);
    unmount();

    // Not running — send button visible (no stop button)
    renderWithProviders(
      <PromptInput onSubmit={vi.fn()} running={false} />
    );
    expect(screen.queryByTitle('prompt.stopAgent')).toBeNull();
  });

  test('submit clears the textarea', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'task' } });
    expect(textarea.value).toBe('task');

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  test('submit preserves textarea when onSubmit returns false', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    renderWithProviders(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'my task' } });
    expect(textarea.value).toBe('my task');

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(textarea.value).toBe('my task');
  });

  test('textarea is disabled when loading=true', () => {
    renderWithProviders(<PromptInput onSubmit={vi.fn()} loading={true} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });
});
