import { describe, expect, test, vi } from 'vitest';

import { getDirectoryOpenCommand, openDirectoryOnHost } from '../../services/directory-opener.js';

function stderrStream(message = ''): ReadableStream<Uint8Array> {
  return new Blob([message]).stream();
}

describe('directory opener', () => {
  test('builds the platform-specific command without using a shell', () => {
    expect(getDirectoryOpenCommand('/tmp/project', 'linux')).toEqual(['xdg-open', '/tmp/project']);
    expect(getDirectoryOpenCommand('/tmp/project', 'darwin')).toEqual(['open', '/tmp/project']);
    expect(getDirectoryOpenCommand('C:/project', 'win32')).toEqual(['explorer', 'C:\\project']);
  });

  test('resolves only after the opener accepts the request', async () => {
    const spawn = vi.fn(() => ({ exited: Promise.resolve(0), stderr: stderrStream() }));

    await expect(openDirectoryOnHost('/tmp/project', 'linux', spawn)).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith(['xdg-open', '/tmp/project']);
  });

  test('reports a non-zero opener exit instead of returning a false success', async () => {
    const spawn = vi.fn(() => ({
      exited: Promise.resolve(3),
      stderr: stderrStream('no method available for opening directory'),
    }));

    await expect(openDirectoryOnHost('/tmp/project', 'linux', spawn)).rejects.toThrow(
      'xdg-open exited with code 3: no method available for opening directory',
    );
  });

  test('reports when the opener executable cannot start', async () => {
    const spawn = vi.fn(() => {
      throw new Error('ENOENT');
    });

    await expect(openDirectoryOnHost('/tmp/project', 'linux', spawn)).rejects.toThrow(
      'Could not start xdg-open: ENOENT',
    );
  });
});
