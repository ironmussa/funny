/**
 * The automation schedule field: choosing "Custom cron…" while the schedule
 * matches a preset must open the cron input (it used to snap back to the
 * preset and do nothing).
 */
import { describe, expect, mock, test } from 'bun:test';

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

mock.module('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      data-testid="schedule-select"
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

import { defaultForm, type FormState } from '@/components/automation-settings/automation-form';
import { ScheduleField } from '@/components/automation-settings/AutomationFormDialog';

function Harness({ schedule }: { schedule: string }) {
  const [form, setForm] = useState<FormState>({ ...defaultForm, schedule });
  return (
    <>
      <ScheduleField form={form} setForm={setForm} />
      <output data-testid="schedule-value">{form.schedule}</output>
    </>
  );
}

describe('ScheduleField', () => {
  test('choosing Custom cron on a preset shows the cron input', () => {
    render(<Harness schedule="0 9 * * *" />);
    expect(screen.queryByTestId('automation-schedule-custom')).toBeNull();

    fireEvent.change(screen.getByTestId('schedule-select'), { target: { value: '__custom__' } });

    const input = screen.getByTestId('automation-schedule-custom') as HTMLInputElement;
    expect(input.value).toBe('0 9 * * *');
    expect((screen.getByTestId('schedule-select') as HTMLSelectElement).value).toBe('__custom__');

    fireEvent.change(input, { target: { value: '0 8 * * *' } });
    expect(screen.getByTestId('schedule-value').textContent).toBe('0 8 * * *');
  });

  test('custom mode stays open while the typed cron matches a preset', () => {
    render(<Harness schedule="0 8 * * *" />);
    const input = screen.getByTestId('automation-schedule-custom');
    fireEvent.change(input, { target: { value: '0 9 * * *' } });
    expect(screen.getByTestId('automation-schedule-custom')).toBeTruthy();
  });

  test('picking a preset closes the custom input', () => {
    render(<Harness schedule="0 8 * * *" />);
    fireEvent.change(screen.getByTestId('schedule-select'), { target: { value: '0 * * * *' } });
    expect(screen.queryByTestId('automation-schedule-custom')).toBeNull();
    expect(screen.getByTestId('schedule-value').textContent).toBe('0 * * * *');
  });
});
