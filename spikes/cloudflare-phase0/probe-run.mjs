// Boots the server-probe bundle in local workerd and requests /api/health.
import { unstable_startWorker } from 'wrangler';
const w = await unstable_startWorker({
  config: 'wrangler.server-probe.jsonc',
  dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, logLevel: 'log' },
});
await w.ready;
const base = (await w.url).toString();
for (const path of ['api/health', 'api/bootstrap']) {
  try {
    const res = await fetch(base + path, { signal: AbortSignal.timeout(20000) });
    console.log('PROBE', path, res.status, (await res.text()).slice(0, 300));
  } catch (error) {
    console.log('PROBE', path, 'request failed:', error.message);
  }
}
await w.dispose();
