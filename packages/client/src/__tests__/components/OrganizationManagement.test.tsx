import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { OrganizationManagement } from '@/components/settings/OrganizationManagement';

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    getSession: auth.getSession,
    organization: {
      list: auth.list,
      create: auth.create,
    },
  },
}));

describe('OrganizationManagement create form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getSession.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    auth.list.mockResolvedValue({ data: [] });
    auth.create.mockResolvedValue({ data: { id: 'org-1' } });
  });

  test('tracks manual slug editing without requiring render state', async () => {
    render(<OrganizationManagement />);

    const name = await screen.findByTestId('org-create-name');
    const slug = screen.getByTestId('org-create-slug');
    fireEvent.change(name, { target: { value: 'First Org' } });
    expect(slug).toHaveValue('first-org');

    fireEvent.change(slug, { target: { value: 'custom-slug' } });
    fireEvent.change(name, { target: { value: 'Renamed Org' } });
    expect(slug).toHaveValue('custom-slug');

    fireEvent.click(screen.getByTestId('org-create-submit'));
    await waitFor(() => expect(auth.create).toHaveBeenCalledOnce());
    await waitFor(() => expect(name).toHaveValue(''));

    fireEvent.change(name, { target: { value: 'Second Org' } });
    expect(slug).toHaveValue('second-org');
  });
});
