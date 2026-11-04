import { createNativeApplicationServices } from './application';
import { resolveNativeDiagnosticMode } from './diagnostic-mode';
import { currentNativeHostInput, detectNativeHostSupport } from './host-support';
import { forwardTerminationSignals, planNativeWindowBackend } from './native-backend';
import { createNativeClientComposition } from './platform/composition';

const support = detectNativeHostSupport(currentNativeHostInput());
if (!support.supported) {
  process.stderr.write(
    `Funny GPUIX is unsupported: ${support.reason}. Use ${support.fallbackCommand}.\n`,
  );
  process.exitCode = 1;
} else {
  const backendPlan = planNativeWindowBackend({
    platform: process.platform,
    preference: process.env.FUNNY_GPUIX_LINUX_BACKEND,
    environment: process.env,
  });
  if (backendPlan.relaunchEnvironment) {
    const child = Bun.spawn({
      cmd: [process.execPath, ...process.argv.slice(1)],
      env: backendPlan.relaunchEnvironment,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    forwardTerminationSignals(process, child);
    process.exit(await child.exited);
  }
  const composition = createNativeClientComposition({
    serverOrigin: process.env.FUNNY_SERVER_ORIGIN,
    clientOrigin: process.env.FUNNY_CLIENT_ORIGIN,
    persistentSession: process.env.FUNNY_GPUX_PERSIST_SESSION !== 'false',
  });
  const application = createNativeApplicationServices(composition);
  const { startNativeClient } = await import('./native-entry');
  startNativeClient(
    composition,
    application,
    resolveNativeDiagnosticMode(process.env.FUNNY_GPUIX_DIAGNOSTICS),
    // Closing the host ends the app; disposed services can still hold timers or sockets open.
    () => process.exit(0),
  );
  void application.start();
}
