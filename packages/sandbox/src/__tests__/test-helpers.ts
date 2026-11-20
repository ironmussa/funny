import type { SandboxProvider } from '../contract.js';

/**
 * Keeps the concrete test double behind each provider the contract suite
 * creates, so a harness hook that receives the provider as `SandboxProvider`
 * can reach the double's test controls without a cast.
 */
export function createProviderDoubles<T>() {
  const doubles = new WeakMap<SandboxProvider, T>();
  return {
    track<P extends SandboxProvider>(provider: P, double: T): P {
      doubles.set(provider, double);
      return provider;
    },
    of(provider: SandboxProvider): T {
      const double = doubles.get(provider);
      if (double === undefined) throw new Error('provider was not created by this harness');
      return double;
    },
  };
}
