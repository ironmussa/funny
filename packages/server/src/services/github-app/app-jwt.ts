/**
 * The JWT a GitHub App authenticates with as itself (sandbox-github-app-tokens).
 * RS256 with the App's private key; valid for 9 minutes (GitHub's limit is 10),
 * issued a minute in the past to absorb clock drift.
 */

import { createSign } from 'node:crypto';

import { Result } from 'neverthrow';

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

export function signAppJwt(
  appId: string,
  privateKey: string,
  now: Date = new Date(),
): Result<string, string> {
  return Result.fromThrowable(
    () => {
      const iat = Math.floor(now.getTime() / 1000) - 60;
      const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const payload = base64url(JSON.stringify({ iat, exp: iat + 9 * 60 + 60, iss: appId }));
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${payload}`);
      return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
    },
    (error) =>
      `could not sign the GitHub App JWT: ${error instanceof Error ? error.message : String(error)}`,
  )();
}
