interface DirectoryOpenerProcess {
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array>;
}

type SpawnDirectoryOpener = (command: string[]) => DirectoryOpenerProcess;

function defaultSpawnDirectoryOpener(command: string[]): DirectoryOpenerProcess {
  return Bun.spawn(command, {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
}

export function getDirectoryOpenCommand(directoryPath: string, os: NodeJS.Platform): string[] {
  if (os === 'win32') {
    return ['explorer', directoryPath.replace(/\//g, '\\')];
  }
  if (os === 'darwin') {
    return ['open', directoryPath];
  }
  return ['xdg-open', directoryPath];
}

/**
 * Ask the host OS to open a directory and wait until its dispatcher confirms
 * that the request was accepted. Desktop opener commands normally exit as
 * soon as they hand the path to the file manager.
 */
export async function openDirectoryOnHost(
  directoryPath: string,
  os: NodeJS.Platform,
  spawnDirectoryOpener: SpawnDirectoryOpener = defaultSpawnDirectoryOpener,
): Promise<void> {
  const command = getDirectoryOpenCommand(directoryPath, os);

  let process: DirectoryOpenerProcess;
  try {
    process = spawnDirectoryOpener(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not start ${command[0]}: ${message}`);
  }

  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode === 0) return;

  const detail = stderr.trim();
  throw new Error(
    detail
      ? `${command[0]} exited with code ${exitCode}: ${detail}`
      : `${command[0]} exited with code ${exitCode}`,
  );
}
