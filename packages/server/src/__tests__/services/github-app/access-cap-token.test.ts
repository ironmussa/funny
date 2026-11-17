import { describe, expect, test } from 'bun:test';

import { createAccessCapToken } from '../../../services/github-app/access-cap-token.js';

/** Project p1 is bob's, with bob's project token; alice and bob each saved a PAT. */
const capFor = (pats: Record<string, string | null> = { alice: 'pat_alice', bob: 'pat_bob' }) =>
  createAccessCapToken({
    projectOwner: async (projectId) => (projectId === 'p1' ? 'bob' : null),
    projectToken: async (projectId) => (projectId === 'p1' ? 'project_token_bob' : null),
    userToken: async (userId) => pats[userId] ?? null,
  });

describe('the token that caps an App token minted for a user', () => {
  test("the project owner's threads use the project token", async () => {
    expect(await capFor()('bob', 'p1')).toBe('project_token_bob');
  });

  test("a member is capped by their own PAT, never by the owner's project token", async () => {
    expect(await capFor()('alice', 'p1')).toBe('pat_alice');
  });

  test('a member with no PAT gets no token at all', async () => {
    expect(await capFor({ bob: 'pat_bob' })('alice', 'p1')).toBeNull();
  });

  test('the owner falls back to their own PAT when the project has no token, as does a projectless thread', async () => {
    expect(await capFor()('bob', 'p2')).toBe('pat_bob');
    expect(await capFor()('alice', null)).toBe('pat_alice');
  });
});
