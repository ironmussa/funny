/** Register on demand; this worker does not cache or intercept requests. */
export async function getNotificationWorker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register('/notification-sw.js');
  if (registration.active) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new Error('Notification worker unavailable');
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      worker.removeEventListener('statechange', check);
    };
    const check = () => {
      if (worker.state === 'activated') {
        cleanup();
        resolve();
      } else if (worker.state === 'redundant') {
        cleanup();
        reject(new Error('Notification worker installation failed'));
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Notification worker activation timed out'));
    }, 10000);
    worker.addEventListener('statechange', check);
    check();
  });
  return registration;
}
