import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { FactorySettings } from '@/lib/api/factory';

const mocks = vi.hoisted(() => ({
  settings: null as FactorySettings | null,
  save: vi.fn(),
}));

vi.mock('@/hooks/use-project-factory', () => ({
  useProjectFactory: () => ({ settings: mocks.settings, loading: false, save: mocks.save }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}));

import { ProjectFactorySetting } from '@/components/general-settings-project/ProjectFactorySetting';

const configured = (over: Partial<FactorySettings> = {}): FactorySettings => ({
  projectId: 'p1',
  enabled: true,
  label: 'ready-for-agent',
  flowName: 'issue-to-merge',
  maxConcurrent: 2,
  updatedAt: '2026-11-16T00:00:00.000Z',
  ...over,
});

const pressed = (v: string) =>
  screen.getByTestId(`settings-factory-${v}`).getAttribute('aria-pressed');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = null;
  mocks.save.mockResolvedValue(undefined);
});

describe('ProjectFactorySetting', () => {
  test('off by default, with no detail rows', () => {
    render(<ProjectFactorySetting projectId="p1" />);
    expect(pressed('off')).toBe('true');
    expect(screen.queryByTestId('settings-factory-label')).toBeNull();
  });

  test('turning it on saves enabled', () => {
    render(<ProjectFactorySetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-factory-on'));
    expect(mocks.save).toHaveBeenCalledWith({ enabled: true });
  });

  test('enabled shows the detail rows with their values', () => {
    mocks.settings = configured({ label: 'bug', maxConcurrent: 4 });
    render(<ProjectFactorySetting projectId="p1" />);
    expect(pressed('on')).toBe('true');
    expect(screen.getByTestId('settings-factory-label')).toHaveValue('bug');
    expect(screen.getByTestId('settings-factory-concurrency')).toHaveValue(4);
  });

  test('editing the label saves it, carrying the enabled flag', () => {
    mocks.settings = configured();
    render(<ProjectFactorySetting projectId="p1" />);
    const input = screen.getByTestId('settings-factory-label');
    fireEvent.blur(input, { target: { value: 'needs-agent' } });
    expect(mocks.save).toHaveBeenCalledWith({ enabled: true, label: 'needs-agent' });
  });

  test('an out-of-range concurrency is not saved', () => {
    mocks.settings = configured();
    render(<ProjectFactorySetting projectId="p1" />);
    fireEvent.blur(screen.getByTestId('settings-factory-concurrency'), { target: { value: '99' } });
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
