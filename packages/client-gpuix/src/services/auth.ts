import type { ClientPlatform, StoreApi, AuthSessionState } from '@funny/client-core';
import type { SafeUser } from '@funny/shared';

import type { NativeCookieJar } from '../platform/transport';
import { NativeApiError, nativeJsonRequest } from './native-api';

interface BetterAuthSession {
  user?: Record<string, unknown> | null;
  session?: Record<string, unknown> | null;
}

export interface NativeAuthBootstrap {
  user: SafeUser;
  profile: Record<string, unknown>;
}

function safeUser(value: Record<string, unknown>): SafeUser | null {
  if (typeof value.id !== 'string') return null;
  const username =
    typeof value.username === 'string'
      ? value.username
      : typeof value.name === 'string'
        ? value.name
        : 'user';
  return {
    id: value.id,
    username,
    displayName: typeof value.name === 'string' ? value.name : username,
    role: value.role === 'admin' ? 'admin' : 'user',
  };
}

export class NativeAuthService {
  private profile: Record<string, unknown> | null = null;

  constructor(
    private readonly options: {
      platform: ClientPlatform;
      cookies: NativeCookieJar;
      state: StoreApi<AuthSessionState>;
      clientOrigin: string;
      delay?: (milliseconds: number) => Promise<void>;
    },
  ) {}

  currentProfile(): Record<string, unknown> | null {
    return this.profile;
  }

  async restore(): Promise<NativeAuthBootstrap | null> {
    this.options.state.getState().bootstrap();
    try {
      const session = await this.session();
      if (!session) {
        this.clearSession();
        return null;
      }
      return await this.finishBootstrap(session);
    } catch (error) {
      this.report('auth.restore', error);
      if (error instanceof NativeApiError && error.status === 401) {
        this.clearSession();
        return null;
      }
      this.options.state.getState().reject(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async signIn(username: string, password: string): Promise<NativeAuthBootstrap> {
    this.options.state.getState().bootstrap();
    try {
      await this.request('/auth/sign-in/username', 'POST', { username, password });
      let session: BetterAuthSession | null = null;
      for (let attempt = 0; attempt < 10 && !session?.user; attempt += 1) {
        session = await this.session();
        if (!session?.user) await (this.options.delay ?? Bun.sleep)(80);
      }
      if (!session?.user) throw new Error('Authenticated session was not established');
      return await this.finishBootstrap(session);
    } catch (error) {
      this.report('auth.sign-in', error);
      this.options.cookies.clear();
      this.profile = null;
      this.options.state.getState().reject(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async logout(): Promise<void> {
    try {
      await this.request('/auth/sign-out', 'POST');
    } catch (error) {
      this.report('auth.logout', error);
    } finally {
      this.clearSession();
    }
  }

  rejectSession(message = 'Session expired'): void {
    this.options.cookies.clear();
    this.profile = null;
    this.options.state.getState().reject(message);
  }

  private async session(): Promise<BetterAuthSession | null> {
    const response = await this.request<BetterAuthSession | null>('/auth/get-session');
    return response?.user ? response : null;
  }

  private async finishBootstrap(session: BetterAuthSession): Promise<NativeAuthBootstrap> {
    const user = session.user ? safeUser(session.user) : null;
    if (!user) throw new Error('Session user payload is invalid');
    const profile = await this.request<Record<string, unknown>>('/profile');
    const activeOrgId = session.session?.activeOrganizationId;
    this.profile = profile;
    this.options.state
      .getState()
      .authenticate(
        user,
        typeof activeOrgId === 'string' ? { id: activeOrgId, name: null, slug: null } : null,
      );
    return { user, profile };
  }

  private clearSession(): void {
    this.options.cookies.clear();
    this.profile = null;
    this.options.state.getState().becomeAnonymous();
  }

  private request<T = unknown>(path: string, method?: string, body?: unknown): Promise<T> {
    return nativeJsonRequest<T>({ ...this.options, path, method, body });
  }

  private report(operation: string, error: unknown): void {
    this.options.platform.diagnostics.report({ capability: 'transport', operation, error });
  }
}
