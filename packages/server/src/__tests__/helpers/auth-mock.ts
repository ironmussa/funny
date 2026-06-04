/**
 * Shared mutable state for auth.api mocks across test files.
 *
 * Bun's mock.module is global — multiple test files mocking ../../lib/auth.js
 * must share state and base handlers or later files silently override earlier mocks.
 */

export const authMockState = {
  hasPermission: true,
  permissionCheckThrows: false,
  createUserShouldFail: false,
  createUserShouldThrow: false,
  inviteMemberError: null as string | null,
  orgs: {
    'org-acme': { id: 'org-acme', name: 'Acme Corp' },
    'org-1': { id: 'org-1', name: 'Acme Team' },
  } as Record<string, { id: string; name: string }>,
  users: {} as Record<string, { id: string; email: string; name: string }>,
};

export function resetAuthMockUsers(): void {
  authMockState.users = {};
  authMockState.createUserShouldFail = false;
  authMockState.createUserShouldThrow = false;
  authMockState.inviteMemberError = null;
}

export function createAuthApiMock(
  extra: Record<string, unknown> = {},
): { hasPermission: () => Promise<boolean> } & Record<string, unknown> {
  return {
    hasPermission: async () => {
      if (authMockState.permissionCheckThrows) {
        throw new Error('permission service unavailable');
      }
      return authMockState.hasPermission;
    },
    getFullOrganization: async ({ query }: { query: { organizationId: string } }) =>
      authMockState.orgs[query.organizationId] ?? null,
    updateOrganization: async () => {},
    createUser: async ({
      body,
    }: {
      body: Record<string, unknown> & { data?: { username?: string } };
    }) => {
      if (authMockState.createUserShouldThrow) {
        throw new Error('duplicate username');
      }
      if (authMockState.createUserShouldFail) {
        return {};
      }
      const username = body.data?.username ?? 'user';
      const user = {
        id: `user-${username}`,
        email: body.email as string,
        name: body.name as string,
      };
      authMockState.users[user.id] = user;
      return { user };
    },
    signInUsername: async () => ({
      headers: {
        getSetCookie: () => ['funny.session=test-session; Path=/; HttpOnly'],
      },
    }),
    inviteMember: async () => {
      if (authMockState.inviteMemberError) {
        throw new Error(authMockState.inviteMemberError);
      }
    },
    listInvitations: async () => [],
    acceptInvitation: async () => {},
    setActiveOrganization: async () => {},
    listUsers: async () => ({ users: Object.values(authMockState.users) }),
    ...extra,
  };
}

/** Clear cached auth instance so requirePermission re-imports the mock. */
export async function resetAuthMiddlewareCache(): Promise<void> {
  const { resetAuthInstanceForTests } = await import('../../middleware/auth.js');
  resetAuthInstanceForTests();
}
