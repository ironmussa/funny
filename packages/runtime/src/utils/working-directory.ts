import { statSync } from 'node:fs';

import { badRequest, type DomainError } from '@funny/shared/errors';
import { err, ok, type Result } from 'neverthrow';

/** Validate on the runner, where the authorized checkout actually lives. */
export function requireWorkingDirectory(path: string): Result<string, DomainError> {
  try {
    if (statSync(path).isDirectory()) return ok(path);
    return err(
      badRequest(
        `The project location "${path}" is not a folder. Restore the project folder or remove this project and add it again from its new location.`,
      ),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return err(
        badRequest(
          `The project folder "${path}" could not be found. It may have been moved or deleted. Restore it at this location and retry, or remove this project and add it again from its new location.`,
        ),
      );
    }
    return err(
      badRequest(
        `The project folder "${path}" cannot be accessed. Check its permissions and that the drive is connected, then retry.`,
      ),
    );
  }
}
