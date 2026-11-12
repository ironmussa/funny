import type { CreatePersonalTokenBody } from '@funny/shared/contracts/personal-tokens';

import { trpc, trpcCall } from './_trpc';

export type { PersonalAccessTokenInfo } from '@funny/shared/contracts/personal-tokens';

const procedures = trpc.personalTokens;

/** The caller's personal API tokens for the public REST API (public-rest-api-v1). */
export const personalTokensApi = {
  listPersonalTokens: () => trpcCall(() => procedures.list.query()),
  /** The answer's `token` is the only time the plaintext is available. */
  createPersonalToken: (data: CreatePersonalTokenBody) =>
    trpcCall(() => procedures.create.mutate(data)),
  revokePersonalToken: (id: string) => trpcCall(() => procedures.revoke.mutate({ id })),
};
