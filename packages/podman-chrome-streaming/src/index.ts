import { ChromeSession, waitForChrome } from '@funny/core/chrome';

import { StreamingServer } from './streaming-server.ts';

const CHROME_HOST = process.env.CHROME_HOST ?? 'localhost';
const CHROME_PORT = parseInt(process.env.CHROME_DEBUG_PORT ?? process.env.CHROME_PORT ?? '9222');
const HTTP_PORT = parseInt(process.env.STREAM_HTTP_PORT ?? process.env.HTTP_PORT ?? '3500');
const WS_PORT = parseInt(process.env.STREAM_WS_PORT ?? process.env.WS_PORT ?? '3501');
const START_URL = process.env.START_URL ?? 'https://example.com';

async function main() {
  console.log('=== podman-chrome-streaming (stream-only) ===');
  console.log(`  Viewer  : http://0.0.0.0:${HTTP_PORT}`);
  console.log(`  WS      : ws://0.0.0.0:${WS_PORT}`);
  console.log(`  Chrome  : ${CHROME_HOST}:${CHROME_PORT}`);
  console.log(`  Start URL: ${START_URL}`);
  console.log('--------------------------------\n');

  // 1. Start streaming server first (so viewer loads even if Chrome is not ready)
  const server = new StreamingServer({ httpPort: HTTP_PORT, wsPort: WS_PORT });
  server.startHttpServer();

  // 2. Wait for Chrome to be available (useful when container starts Chrome alongside)
  await waitForChrome(CHROME_HOST, CHROME_PORT);

  // 3. Connect CDP session and attach to streaming server
  const session = new ChromeSession({
    host: CHROME_HOST,
    port: CHROME_PORT,
    format: 'jpeg',
    quality: 80,
    maxWidth: 1280,
    maxHeight: 720,
    everyNthFrame: 1,
  });

  server.attachSession(session);

  await session.connect();
  await session.navigate(START_URL);

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('\n[main] SIGTERM received. Shutting down...');
    await session.disconnect();
    await server.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('\n[main] SIGINT received. Shutting down...');
    await session.disconnect();
    await server.shutdown();
    process.exit(0);
  });

  // Auto-reconnect on Chrome disconnect
  session.on('disconnect', async () => {
    console.log('[main] Chrome disconnected. Retrying in 5s...');
    await new Promise((r) => setTimeout(r, 5000));
    try {
      await waitForChrome(CHROME_HOST, CHROME_PORT, 30_000);
      await session.connect();
      await session.navigate(START_URL);
    } catch (err) {
      console.error('[main] Reconnect failed:', err);
    }
  });

  console.log(`\n[main] Ready. Open http://localhost:${HTTP_PORT} to view the stream.`);
}

main().catch((err) => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
