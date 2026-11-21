import { afterEach, describe, expect, test, vi, mock } from 'bun:test';

import { fireEvent, render, screen, cleanup } from '@testing-library/react';

import { ProjectListView } from '@/components/mobile/ProjectListView';

mock.module('@/components/mobile/MobileNotifications', () => ({ MobileNotifications: () => null }));
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

describe('mobile add project', () => {
  test('opens creation from the header and the empty state', () => {
    const onAddProject = vi.fn();
    render(<ProjectListView projects={[]} onSelect={vi.fn()} onAddProject={onAddProject} />);
    const buttons = screen.getAllByRole('button', { name: 'sidebar.addProject' });
    expect(buttons).toHaveLength(2);
    buttons.forEach((button) => fireEvent.click(button));
    expect(onAddProject).toHaveBeenCalledTimes(2);
  });
});
