import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { PlanReviewDialog } from '@/components/tool-cards/PlanReviewDialog';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, options?: Record<string, unknown>) => {
      if (!fallback) return _key;
      return fallback.replace(/\{\{count\}\}/g, String(options?.count ?? ''));
    },
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' }),
}));

vi.mock('@/lib/monaco-setup', () => ({}));

vi.mock('@monaco-editor/react', () => ({
  Editor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string | undefined) => void;
  }) => (
    <textarea
      data-testid="mock-plan-editor"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

const PLAN = `## Implementation Plan

1. Wire the dialog actions
2. Add regression tests`;

function renderDialog({
  comments = [],
  onRespond = vi.fn(),
}: {
  comments?: { selectedText: string; comment: string; emoji?: string }[];
  onRespond?: (answer: string) => void;
} = {}) {
  const onOpenChange = vi.fn();
  render(
    <TooltipProvider>
      <PlanReviewDialog
        open
        onOpenChange={onOpenChange}
        plan={PLAN}
        planComments={comments}
        onAddComment={vi.fn()}
        onAddEmoji={vi.fn()}
        onRemoveComment={vi.fn()}
        onRespond={onRespond}
      />
    </TooltipProvider>,
  );
  return { onOpenChange, onRespond };
}

describe('PlanReviewDialog', () => {
  test('accepts the current plan from the review dialog', () => {
    const { onOpenChange, onRespond } = renderDialog();

    fireEvent.click(screen.getByTestId('plan-review-accept'));

    expect(onRespond).toHaveBeenCalledWith('Plan accepted');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('accepts edited plan text from edit mode', async () => {
    const { onRespond } = renderDialog();

    fireEvent.click(screen.getByTestId('plan-review-toggle-edit'));
    const editor = await screen.findByTestId('mock-plan-editor');
    fireEvent.change(editor, {
      target: { value: `${PLAN}\n3. Verify the modal response` },
    });
    fireEvent.click(screen.getByTestId('plan-review-accept'));

    expect(onRespond).toHaveBeenCalledWith(
      `${'Plan accepted with revisions:'}\n\n${PLAN}\n3. Verify the modal response`,
    );
  });

  test('sends plan comments from the review dialog', () => {
    const { onRespond } = renderDialog({
      comments: [
        {
          selectedText: 'Wire the dialog actions',
          comment: 'Make sure this works from the modal.',
        },
      ],
    });

    fireEvent.click(screen.getByTestId('plan-review-send-comments'));

    expect(onRespond).toHaveBeenCalledWith(
      'Feedback on plan:\n\n> Wire the dialog actions\nComment: Make sure this works from the modal.',
    );
  });
});
