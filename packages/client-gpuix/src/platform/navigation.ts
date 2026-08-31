import type {
  ClientLocation,
  NavigationOptions,
  NavigationService,
  Unsubscribe,
} from '@funny/client-core';
import { parseClientRoute, type ParsedClientRoute } from '@funny/client-core';

export class NativeNavigationService implements NavigationService {
  private location: ClientLocation;
  private readonly listeners = new Set<(location: ClientLocation) => void>();

  constructor(initial: ClientLocation = { pathname: '/', search: '', hash: '' }) {
    this.location = { ...initial };
  }

  current(): ClientLocation {
    return { ...this.location };
  }

  route(): ParsedClientRoute {
    return parseClientRoute(this.location.pathname);
  }

  navigate(to: ClientLocation, _options?: NavigationOptions): void {
    if (
      to.pathname === this.location.pathname &&
      to.search === this.location.search &&
      to.hash === this.location.hash
    ) {
      return;
    }
    this.location = { ...to };
    for (const listener of this.listeners) listener(this.current());
  }

  subscribe(listener: (location: ClientLocation) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
