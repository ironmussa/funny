/**
 * Security CR-1 — pure helper that identifies pairs of identical secrets.
 *
 * Each shared secret authenticates a distinct trust boundary
 * (runner↔server, orchestrator↔server, external webhook→runner). Reusing
 * one value across two of them means compromise of any single channel
 * leaks the other.
 *
 * Returns a list of `[envVarA, envVarB]` pairs that are set to the same
 * value. An empty array means the secrets are properly distinct (or any
 * undefined value is paired only with other undefineds, which is also
 * acceptable — the boot script's downstream checks enforce presence).
 */
export type SecretName =
  | 'RUNNER_AUTH_SECRET'
  | 'INGEST_WEBHOOK_SECRET'
  | 'ORCHESTRATOR_AUTH_SECRET';

export function findDuplicateSecretPairs(
  secrets: Partial<Record<SecretName, string | undefined>>,
): Array<[SecretName, SecretName]> {
  const entries: Array<[SecretName, string]> = (
    [
      ['RUNNER_AUTH_SECRET', secrets.RUNNER_AUTH_SECRET],
      ['INGEST_WEBHOOK_SECRET', secrets.INGEST_WEBHOOK_SECRET],
      ['ORCHESTRATOR_AUTH_SECRET', secrets.ORCHESTRATOR_AUTH_SECRET],
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
