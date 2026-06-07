import { describe, test, expect } from 'vitest';

import { authorAvatarUrl } from '@/lib/author-avatar';

describe('authorAvatarUrl', () => {
  test('returns null for empty email', async () => {
    expect(await authorAvatarUrl(null)).toBeNull();
    expect(await authorAvatarUrl('   ')).toBeNull();
  });

  test('maps GitHub noreply emails to avatar URLs', async () => {
    // No numeric id → fall back to the username-based avatar URL.
    await expect(authorAvatarUrl('octocat@users.noreply.github.com')).resolves.toBe(
      'https://github.com/octocat.png?size=64',
    );
    // With the numeric id prefix, prefer the id-based endpoint — it resolves for
    // both users and bot accounts (e.g. "dependabot[bot]") whose bracketed
    // usernames break the username URL.
    await expect(authorAvatarUrl('123456+octocat@users.noreply.github.com')).resolves.toBe(
      'https://avatars.githubusercontent.com/u/123456?size=64',
    );
  });

  test('maps regular emails to gravatar URLs', async () => {
    const url = await authorAvatarUrl('User@Example.com');
    expect(url).toMatch(/^https:\/\/gravatar\.com\/avatar\/[a-f0-9]{64}\?s=64&d=identicon$/);
  });
});
