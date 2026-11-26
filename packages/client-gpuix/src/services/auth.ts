import type { ClientPlatform, StoreApi, AuthSessionState } from '@funny/client-core';
import type { SafeUser, UserProfile } from '@funny/shared';
import { retryAsync } from '@funny/shared/async';
import type { JsonObject, JsonValue } from '@funny/shared/json';

import type { NativeCookieJar } from '../platform/transport';
import { NativeApiError, nativeJsonRequest } from './native-api';

/** Better Auth's `get-session` answer; its user and session fields are checked where read. */
interface BetterAuthSession {
  user?: JsonObject | null;
  session?: JsonObject | null;
}

export interface NativeAuthBootstrap {
  user: SafeUser;
  profile: UserProfile;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function safeUser(value: JsonObject): SafeUser | null {
  if (!isString(value.id)) return null;
  const username = isString(value.username)
    ? value.username
    : isString(value.name)
      ? value.name
      : 'user';
  return {
    id: value.id,
    username,
    displayName: isString(value.name) ? value.name : username,
    role: value.role === 'admin' ? 'admin' : 'user',
  };
}

export class NativeAuthService {
  private profile: UserProfile | null = null;

  constructor(
    private readonly options: {
      platform: ClientPlatform;
      cookies: NativeCookieJar;
      state: StoreApi<AuthSessionState>;
      clientOrigin: string;
      delay?: (milliseconds: number) => Promise<void>;
    },
  ) {}

  currentProfile(): UserProfile | null {
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
      const pending = new Error('Authenticated session was not established');
      // The session cookie can lag the sign-in response; poll briefly for it.
      const session = await retryAsync(
        async () => {
          const current = await this.session();
          if (!current?.user) throw pending;
          return current;
        },
        {
          times: 9,
          delayMs: () => 80,
          while: (error) => error === pending,
          sleep: this.options.delay,
        },
      );
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
    const profile = await this.request<UserProfile>('/profile');
    const activeOrgId = session.session?.activeOrganizationId;
    this.profile = profile;
    this.options.state
      .getState()
      .authenticate(
        user,
        isString(activeOrgId) ? { id: activeOrgId, name: null, slug: null } : null,
      );
    return { user, profile };
  }

  private clearSession(): void {
    this.options.cookies.clear();
    this.profile = null;
    this.options.state.getState().becomeAnonymous();
  }

  private request<T = unknown>(path: string, method?: string, body?: JsonValue): Promise<T> {
    return nativeJsonRequest<T>({ ...this.options, path, method, body });
  }

  private report(operation: string, cause: unknown): void {
    this.options.platform.diagnostics.report({ capability: 'transport', operation, error: cause });
  }
}
