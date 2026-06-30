/**
 * Security CR-1 — pure helper that identifies pairs of identical secrets.
 *
 * Each shared secret authenticates a distinct trust boundary
 * (runner↔server, scheduler↔server, external webhook→runner). Reusing
 * one value across two of them means compromise of any single channel
 * leaks the other.
 *
 * Returns a list of `[envVarA, envVarB]` pairs that are set to the same
 * value. An empty array means the secrets are properly distinct (or any
 * undefined value is paired only with other undefineds, which is also
 * acceptable — the boot script's downstream checks enforce presence).
 */
export type SecretName = 'RUNNER_AUTH_SECRET' | 'INGEST_WEBHOOK_SECRET' | 'SCHEDULER_AUTH_SECRET';

export function findDuplicateSecretPairs(
  secrets: Partial<Record<SecretName, string | undefined>>,
): Array<[SecretName, SecretName]> {
  const entries: Array<[SecretName, string]> = (
    [
      ['RUNNER_AUTH_SECRET', secrets.RUNNER_AUTH_SECRET],
      ['INGEST_WEBHOOK_SECRET', secrets.INGEST_WEBHOOK_SECRET],
      ['SCHEDULER_AUTH_SECRET', secrets.SCHEDULER_AUTH_SECRET],
    ] as const
  ).filter(
    (entry): entry is [SecretName, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  );

  const duplicates: Array<[SecretName, SecretName]> = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i][1] === entries[j][1]) {
        duplicates.push([entries[i][0], entries[j][0]]);
      }
    }
  }
  return duplicates;
}

/**
 * Minimum acceptable length for a shared secret. `RUNNER_AUTH_SECRET` is the
 * HMAC key for forwarded-identity signing — a weak/guessable value lets a
 * caller forge `X-Forwarded-User` for any user (including admin) against a
 * runner's HTTP port. `openssl rand -hex 32` yields 64 chars; we accept down
 * to 32 to allow base64/other encodings while still rejecting obviously weak
 * values like `secret` or `changeme`.
 */
export const MIN_SECRET_LENGTH = 32;

/**
 * Returns the names of any provided secrets that are set but shorter than
 * `MIN_SECRET_LENGTH`. Empty array means all present secrets meet the bar.
 */
export function findWeakSecrets(
  secrets: Partial<Record<SecretName, string | undefined>>,
): SecretName[] {
  return (
    [
      ['RUNNER_AUTH_SECRET', secrets.RUNNER_AUTH_SECRET],
      ['INGEST_WEBHOOK_SECRET', secrets.INGEST_WEBHOOK_SECRET],
      ['SCHEDULER_AUTH_SECRET', secrets.SCHEDULER_AUTH_SECRET],
    ] as const
  )
    .filter(
      (entry): entry is [SecretName, string] =>
        typeof entry[1] === 'string' && entry[1].length > 0 && entry[1].length < MIN_SECRET_LENGTH,
    )
    .map((entry) => entry[0]);
}
