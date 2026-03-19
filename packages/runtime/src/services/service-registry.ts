/**
 * @domain subdomain: Shared Kernel
 * @domain type: port
 * @domain layer: domain
 *
 * Module-level singleton that holds the RuntimeServiceProvider.
 *
 * `setServices()` is called during `createRuntimeApp().init()` with the
 * runner service provider that proxies all data to the central server.
 * All runtime services and route handlers import `getServices()` to
 * access data — they never touch the database directly.
 *
 * Calling `getServices()` before `setServices()` throws immediately so
 * that missing wiring is caught at startup rather than at request time.
 */

import type { RuntimeServiceProvider } from './service-provider.js';

let _services: RuntimeServiceProvider | null = null;

/**
 * Inject the service provider. Must be called once during init().
 * Throws if called more than once (indicates a wiring bug).
 */
export function setServices(services: RuntimeServiceProvider): void {
  if (_services) {
    throw new Error('RuntimeServiceProvider has already been set — double init detected');
  }
  _services = services;
}

/**
 * Retrieve the injected service provider.
 * Throws if called before setServices() (indicates missing wiring).
 */
export function getServices(): RuntimeServiceProvider {
  if (!_services) {
    throw new Error(
      'RuntimeServiceProvider has not been set. ' +
        'Ensure createRuntimeApp().init() is called with a services option before handling requests.',
    );
  }
  return _services;
}

/**
 * Reset the service provider (for testing only).
 */
export function resetServices(): void {
  _services = null;
}
