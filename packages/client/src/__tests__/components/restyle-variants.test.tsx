import { describe, expect, test } from 'bun:test';

import { render, screen } from '@testing-library/react';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Command, CommandEmpty, CommandList } from '@/components/ui/command';
import { Textarea } from '@/components/ui/textarea';

// #454: call sites stopped restyling shadcn primitives with classes and use
// named variants instead. These pin the variants' classes (so the call sites
// render as before), that the defaults did not change, and the one visible
// fix: warning alerts were `variant="destructive"` plus warning classes, so
// twMerge kept `dark:border-destructive` and the border was red in dark mode.

function noop() {}

describe('ConfirmDialog warning and confirm styles', () => {
  test('the warning alert uses the warning colors in both themes', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={noop}
        title="Delete worktree"
        description="This removes the worktree."
        warning="2 unpushed commits"
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-status-warning/30');
    expect(alert.className).toContain('bg-status-warning/10');
    expect(alert.className).toContain('text-status-warning');
    expect(alert.className).not.toContain('dark:border-destructive');
    expect(alert.className).not.toContain('border-destructive/50');
    expect(screen.getByText('2 unpushed commits').className).toContain('text-xs');
  });

  test('the destructive confirm button keeps the destructive button look', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={noop}
        title="Delete"
        description="Sure?"
        onCancel={noop}
        onConfirm={noop}
      />,
    );

    const confirm = screen.getByTestId('confirm-dialog-confirm');
    expect(confirm.className).toContain('bg-destructive');
    expect(confirm.className).toContain('text-destructive-foreground');
    expect(confirm.className).not.toContain('bg-primary');
  });
});

describe('ui variants added for restyled call sites', () => {
  test('Button gap and reveal replace the gap / hover-opacity overrides', () => {
    expect(buttonVariants({ gap: 'tight' })).toContain('gap-1');
    expect(buttonVariants({ gap: 'snug' })).toContain('gap-1.5');
    expect(buttonVariants({ reveal: 'hover' })).toContain('opacity-0 group-hover:opacity-100');
    // The default keeps the base gap and no reveal.
    expect(buttonVariants()).toContain('gap-2');
    expect(buttonVariants()).not.toContain('opacity-0');
  });

  test('Alert keeps its default look; AlertDescription defaults to text-sm', () => {
    render(
      <Alert>
        <AlertDescription>Body</AlertDescription>
      </Alert>,
    );
    expect(screen.getByRole('alert').className).toContain('bg-background');
    expect(screen.getByText('Body').className).toContain('text-sm');
  });

  test('Textarea mono and textSize change only the font', () => {
    render(<Textarea data-testid="ta" mono textSize="xs" />);
    const cls = screen.getByTestId('ta').className;
    expect(cls).toContain('font-mono');
    expect(cls).toContain('text-xs');
    expect(cls).not.toContain('text-base');
    // The default size's padding and height stay.
    expect(cls).toContain('px-3 py-2');
  });
});

describe('CommandEmpty', () => {
  // It used to set its classes before `{...props}`, so a caller's className
  // replaced them and the empty text lost its muted color and centering.
  test('keeps its base classes next to a caller className and textSize', () => {
    render(
      <Command>
        <CommandList>
          <CommandEmpty textSize="xs" className="mt-2">
            Nothing
          </CommandEmpty>
        </CommandList>
      </Command>,
    );
    const cls = screen.getByText('Nothing').className;
    expect(cls).toContain('text-muted-foreground');
    expect(cls).toContain('text-center');
    expect(cls).toContain('py-3 text-xs');
    expect(cls).toContain('mt-2');
  });
});
