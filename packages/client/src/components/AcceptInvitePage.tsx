import type { SafeUser } from '@funny/shared';
import { errorMessage as caughtMessage } from '@funny/shared/errors';
import { Loader2, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { withCleanup } from '@/lib/while-pending';
import { useAuthStore } from '@/stores/auth-store';

import { InviteModeSwitch } from './accept-invite/InviteModeSwitch';
import { InviteOutcome } from './accept-invite/InviteOutcome';

interface Props {
  token: string;
}

type Step = 'verifying' | 'register' | 'accepting' | 'success' | 'already' | 'error';

/** The user fields the sign-in response carries. */
interface SignedInUser {
  id: string;
  username?: string;
  name?: string;
  role?: SafeUser['role'];
}

/** The form's message for a failed login: the error's own text, else a generic one. */
function loginFailure(message: string | undefined): string {
  return message || 'Login failed';
}

/** Signs in, and answers the error to show or the signed-in user. */
async function attemptLogin(
  username: string,
  password: string,
): Promise<{ error: string } | { user: SignedInUser | undefined }> {
  try {
    const result = await authClient.signIn.username({ username, password });
    if (result.error) return { error: loginFailure(result.error.message) };
    // SAFETY: better-auth's username plugin returns the user row with these fields.
    return { user: result.data?.user as SignedInUser | undefined };
  } catch (err) {
    return { error: loginFailure(caughtMessage(err)) };
  }
}

/** Puts the signed-in user in the auth store; a response without a user changes nothing. */
function storeSignedInUser(u: SignedInUser | undefined): void {
  if (!u) return;
  useAuthStore.setState({
    isAuthenticated: true,
    user: {
      id: u.id,
      username: firstName(u.username, u.name, 'user'),
      displayName: firstName(u.name, u.username, 'User'),
      role: u.role || 'user',
    },
  });
}

/** The first non-empty name, else the last argument. */
function firstName(...names: Array<string | undefined>): string {
  return names.find(Boolean) ?? '';
}

export function AcceptInvitePage({ token }: Props) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const [step, setStep] = useState<Step>('verifying');
  const [errorMessage, setErrorMessage] = useState('');
  const [orgName, setOrgName] = useState('');
  const [role, setRole] = useState('');

  // Registration form
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [isLoginMode, setIsLoginMode] = useState(false);
  const submissionIdRef = useRef(0);

  const acceptInvite = useCallback(async () => {
    setStep('accepting');
    const result = await api.acceptInviteLink(token);
    if (result.isOk()) {
      setStep(result.value.alreadyMember ? 'already' : 'success');
    } else {
      setStep('error');
      setErrorMessage(result.error.message || 'Failed to join organization');
    }
  }, [token]);

  // Verify the token on mount
  const onVerified = useStableCallback(
    (result: Awaited<ReturnType<typeof api.verifyInviteLink>>) => {
      if (result.isOk()) {
        setOrgName(result.value.organizationName);
        setRole(result.value.role);
        if (isAuthenticated) {
          // Already logged in — go straight to accepting
          acceptInvite();
        } else {
          setStep('register');
        }
      } else {
        setStep('error');
        setErrorMessage(result.error.message || 'Invalid or expired invite link');
      }
    },
  );
  useEffect(() => {
    api.verifyInviteLink(token).then((result) => onVerified(result));
  }, [token, onVerified]);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    const submissionId = ++submissionIdRef.current;
    setFormError('');
    setFormLoading(true);

    await withCleanup(
      async () => {
        try {
          // Register + join org via server-side endpoint (bypasses disableSignUp)
          const result = await api.registerViaInvite({
            token,
            username,
            password,
            displayName: displayName || undefined,
          });

          if (submissionIdRef.current !== submissionId) return;

          if (result.isOk()) {
            const { user } = result.value;
            useAuthStore.setState({
              isAuthenticated: true,
              user: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                role: 'user',
              },
            });
            setStep('success');
          } else {
            setFormError(result.error.message || 'Registration failed');
          }
        } catch (err: any) {
          if (submissionIdRef.current === submissionId) {
            setFormError(err.message || 'Registration failed');
          }
        }
      },
      () => {
        // The current submission owns this flag; the cleanup covers every exit path.
        if (submissionIdRef.current === submissionId) setFormLoading(false);
      },
    );
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const submissionId = ++submissionIdRef.current;
    setFormError('');
    setFormLoading(true);

    await withCleanup(
      async () => {
        const outcome = await attemptLogin(username, password);
        if (submissionIdRef.current !== submissionId) return;
        if ('error' in outcome) {
          setFormError(outcome.error);
          return;
        }
        storeSignedInUser(outcome.user);
        // Now accept the invite
        await acceptInvite().catch((err: unknown) => {
          if (submissionIdRef.current === submissionId)
            setFormError(loginFailure(caughtMessage(err)));
        });
      },
      () => {
        // The current submission owns this flag; the cleanup covers every exit path.
        if (submissionIdRef.current === submissionId) setFormLoading(false);
      },
    );
  };

  const switchMode = (toLoginMode: boolean) => {
    submissionIdRef.current++;
    setIsLoginMode(toLoginMode);
    setFormLoading(false);
    setFormError('');
  };

  return (
    <div className="bg-background flex min-h-screen items-center justify-center">
      <div className="border-border bg-card w-full max-w-sm space-y-6 rounded-lg border p-8 text-center shadow-lg">
        {/* Verifying token */}
        {step === 'verifying' && (
          <LoadingState
            fill={false}
            testId="accept-invite-verifying"
            label="Verifying invite link…"
          />
        )}

        {/* Registration / Login form */}
        {step === 'register' && (
          <>
            <UserPlus className="text-primary mx-auto size-8" />
            <div>
              <h2 className="text-foreground text-lg font-semibold">Join {orgName}</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                You've been invited as <span className="font-medium">{role}</span>.{' '}
                {isLoginMode ? 'Sign in to accept.' : 'Create an account to get started.'}
              </p>
            </div>

            <form
              onSubmit={isLoginMode ? handleLogin : handleRegister}
              className="space-y-4 text-left"
            >
              <div className="space-y-2">
                <label htmlFor="invite-username" className="text-foreground text-sm font-medium">
                  Username
                </label>
                <Input
                  id="invite-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Choose a username"
                  autoFocus
                  required
                  data-testid="invite-username"
                />
              </div>

              {!isLoginMode && (
                <div className="space-y-2">
                  <label
                    htmlFor="invite-display-name"
                    className="text-foreground text-sm font-medium"
                  >
                    Display Name
                    <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
                  </label>
                  <Input
                    id="invite-display-name"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Your display name"
                    data-testid="invite-display-name"
                  />
                </div>
              )}

              <div className="space-y-2">
                <label htmlFor="invite-password" className="text-foreground text-sm font-medium">
                  Password
                </label>
                <Input
                  id="invite-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isLoginMode ? 'Your password' : 'Choose a password'}
                  required
                  data-testid="invite-password"
                />
              </div>

              {formError && <p className="text-destructive text-sm">{formError}</p>}

              <Button
                type="submit"
                className="w-full"
                disabled={formLoading || !username || !password}
                data-testid="invite-submit"
              >
                {formLoading ? <Loader2 className="icon-base mr-2 animate-spin" /> : null}
                {isLoginMode ? 'Sign In & Join' : 'Create Account & Join'}
              </Button>
            </form>

            <InviteModeSwitch isLoginMode={isLoginMode} onSwitch={switchMode} />
          </>
        )}

        {/* Accepting invite */}
        {step === 'accepting' && (
          <LoadingState
            fill={false}
            testId="accept-invite-accepting"
            label={`Joining ${orgName}...`}
          />
        )}

        {(step === 'success' || step === 'already' || step === 'error') && (
          <InviteOutcome kind={step} orgName={orgName} errorMessage={errorMessage} />
        )}
      </div>
    </div>
  );
}
