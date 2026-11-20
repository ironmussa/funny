/**
 * Shared mutable state for auth.api mocks across test files.
 *
 * Bun's mock.module is global — multiple test files mocking ../../lib/auth.js
 * must share state and base handlers or later files silently override earlier mocks.
 */

interface AuthMockState {
  hasPermission: boolean;
  permissionCheckThrows: boolean;
  createUserShouldFail: boolean;
  createUserShouldThrow: boolean;
  addMemberError: string | null;
  orgs: Record<string, { id: string; name: string }>;
  users: Record<string, { id: string; email: string; name: string }>;
}

export const authMockState: AuthMockState = {
  hasPermission: true,
  permissionCheckThrows: false,
  createUserShouldFail: false,
  createUserShouldThrow: false,
  addMemberError: null,
  orgs: {
    'org-acme': { id: 'org-acme', name: 'Acme Corp' },
    'org-1': { id: 'org-1', name: 'Acme Team' },
  },
  users: {},
};

export function resetAuthMockUsers(): void {
  authMockState.users = {};
  authMockState.createUserShouldFail = false;
  authMockState.createUserShouldThrow = false;
  authMockState.addMemberError = null;
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
      body: { email: string; name: string; data?: { username?: string } };
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
        email: body.email,
        name: body.name,
      };
      authMockState.users[user.id] = user;
      return { user };
    },
    signInUsername: async () => ({
      headers: {
        getSetCookie: () => ['funny.session=test-session; Path=/; HttpOnly'],
      },
    }),
    addMember: async () => {
      if (authMockState.addMemberError) {
        throw new Error(authMockState.addMemberError);
      }
    },
    setActiveOrganization: async () => new Response('{}'),
    listUsers: async () => ({ users: Object.values(authMockState.users) }),
    ...extra,
  };
}

/** Clear cached auth instance so requirePermission re-imports the mock. */
export async function resetAuthMiddlewareCache(): Promise<void> {
  const { resetAuthInstanceForTests, resetOrgNameCacheForTests } =
    await import('../../middleware/auth.js');
  resetAuthInstanceForTests();
  resetOrgNameCacheForTests();
}
