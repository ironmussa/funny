import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { AcceptInvitePage } from '@/components/AcceptInvitePage';
import { useAuthStore } from '@/stores/auth-store';

import { renderWithProviders } from '../helpers/render';

const apiMock = vi.hoisted(() => ({
  acceptInviteLink: vi.fn(),
  registerViaInvite: vi.fn(),
  verifyInviteLink: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: apiMock }));

vi.mock('@/lib/auth-client', () => ({
  authClient: { signIn: { username: vi.fn() } },
}));

describe('AcceptInvitePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ isAuthenticated: false, user: null });
    apiMock.verifyInviteLink.mockResolvedValue({
      isOk: () => true,
      value: {
        organizationId: 'org-1',
        organizationName: 'Acme',
        role: 'member',
        valid: true,
      },
    });
  });

  test('ignores a registration error after switching to the login form', async () => {
    let rejectRegistration: ((reason: Error) => void) | undefined;
    apiMock.registerViaInvite.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRegistration = reject;
      }),
    );

    renderWithProviders(<AcceptInvitePage token="invite-token" />);

    await screen.findByText('Join Acme');
    fireEvent.change(screen.getByTestId('invite-username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByTestId('invite-password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByTestId('invite-submit'));

    await waitFor(() => expect(apiMock.registerViaInvite).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('invite-switch-login'));

    await act(async () => {
      rejectRegistration?.(new Error('Registration failed after the mode changed'));
    });

    expect(
      screen.getByText(
        (_text, element) =>
          element?.tagName === 'P' &&
          element.textContent === "You've been invited as member. Sign in to accept.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Registration failed after the mode changed'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('invite-submit')).toHaveTextContent('Sign In & Join');
    expect(screen.getByTestId('invite-submit')).not.toBeDisabled();
  });
});
