import { configFromEnv } from './config.ts';
import { startFunnyServer, stopFunnyServer, waitForFunnyServerExit } from './funny-server.ts';
import { prepareWorkspace } from './repo-workspace.ts';

async function main() {
  const config = configFromEnv();

  console.log('=== podman funny runtime ===');
  console.log(`  Runtime enabled : ${config.enableRuntime}`);
  console.log(`  Repo mode       : ${config.repoMode}`);
  console.log(`  Repo ref        : ${config.repoRef || '(default)'}`);
  console.log(`  Work branch     : ${config.workBranch || '(none)'}`);
  console.log(`  Workspace       : ${config.workspacePath}`);
  console.log(`  Funny port      : ${config.funnyPort}`);
  console.log(`  Streaming       : ${config.enableStreaming}`);
  console.log('----------------------------\n');

  if (!config.enableRuntime) {
    console.log('[entrypoint] Runtime disabled, nothing to do.');
    return;
  }

  const workspace = await prepareWorkspace(config);
  console.log(
    `[entrypoint] Workspace ready at ${workspace.workspacePath} ` +
      `(mode: ${workspace.mode}, ref: ${workspace.activeRef}, workBranch: ${workspace.workBranch || 'none'})`,
  );

  await startFunnyServer({
    workspacePath: workspace.workspacePath,
    config,
  });

  const shutdown = async () => {
    console.log('\n[entrypoint] Shutting down...');
    await stopFunnyServer();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const exitCode = await waitForFunnyServerExit();
  process.exit(exitCode ?? 0);
}

main().catch((error) => {
  console.error('[entrypoint] Fatal error:', error);
  process.exit(1);
});
