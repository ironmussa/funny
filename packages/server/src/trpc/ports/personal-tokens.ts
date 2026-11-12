/**
 * The caller's personal API tokens (openspec public-rest-api-v1), for the
 * `personalTokens` tRPC router. Every method acts on the caller's own tokens;
 * the plaintext is only in `create`'s answer.
 */

import { failure, type PersonalTokensPort } from '@funny/api';
import { err, ok } from 'neverthrow';

import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
} from '../../services/personal-access-tokens.js';

const storageFailure = (message: string) => failure(500, message);

export const personalTokensPort: PersonalTokensPort = {
  async list(userId) {
    return listPersonalAccessTokens(userId).mapErr(storageFailure);
  },

  async create(userId, data) {
    return createPersonalAccessToken(userId, data.name, data.days).mapErr(storageFailure);
  },

  async revoke(userId, id) {
    return revokePersonalAccessToken(userId, id)
      .mapErr(storageFailure)
      .andThen((revoked) =>
        revoked ? ok({ ok: true as const }) : err(failure(404, 'Token not found')),
      );
  },
};
