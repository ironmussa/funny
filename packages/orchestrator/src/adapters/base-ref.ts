/**
 * The git ref of a run's base branch in a workspace: `origin/<base>` when the
 * remote-tracking branch exists (a clone), else the local `<base>` branch.
 */

import { git } from '@funny/core/git';
import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

export function resolveBaseRef(cwd: string, base: string): ResultAsync<string, DomainError> {
  return git(['rev-parse', '--verify', '--quiet', `origin/${base}`], cwd)
    .map(() => `origin/${base}`)
    .orElse(() => git(['rev-parse', '--verify', base], cwd).map(() => base));
}
