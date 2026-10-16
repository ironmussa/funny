import { waitFor } from '@funny/shared/async';
/** Register on demand; this worker does not cache or intercept requests. */
export async function getNotificationWorker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register('/notification-sw.js');
  if (registration.active) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new Error('Notification worker unavailable');
  await waitFor<void>(
    (resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener('statechange', check);
      };
      const check = () => {
        if (worker.state === 'activated') {
          resolve();
        } else if (worker.state === 'redundant') {
          reject(new Error('Notification worker installation failed'));
        }
      };
      worker.addEventListener('statechange', check);
      check();
      return cleanup;
    },
    { timeoutMs: 10000, timeoutError: () => new Error('Notification worker activation timed out') },
  );
  return registration;
}
