/**
 * Personal API tokens (openspec public-rest-api-v1): inputs and answers of the
 * `personalTokens` tRPC procedures. A user manages only their own tokens; the
 * plaintext is returned once, by `create`.
 */

import { z } from 'zod';

/** Lifetime of a token when none is chosen, in days. */
export const DEFAULT_TOKEN_DAYS = 90;
/** The longest lifetime a token may have, in days. */
export const MAX_TOKEN_DAYS = 365;

export const createPersonalTokenBody = z
  .object({
    name: z.string().trim().min(1).max(64),
    days: z.number().int().min(1).max(MAX_TOKEN_DAYS).optional(),
  })
  .strict();

export type CreatePersonalTokenBody = z.input<typeof createPersonalTokenBody>;

export const revokePersonalTokenBody = z.object({ id: z.string().min(1) }).strict();

/** A token as listed: never its plaintext or hash. */
export interface PersonalAccessTokenInfo {
  id: string;
  name: string;
  /** The first characters of the token, to tell tokens apart. */
  prefix: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

/** `token` is the only time the plaintext is available. */
export interface CreatedPersonalToken {
  token: string;
  info: PersonalAccessTokenInfo;
}
