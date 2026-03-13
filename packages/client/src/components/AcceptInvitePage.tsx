import { Loader2, CheckCircle2, XCircle, UserPlus } from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { useAuthStore } from '@/stores/auth-store';

interface Props {
  token: string;
}

type Step = 'verifying' | 'register' | 'accepting' | 'success' | 'already' | 'error';

export function AcceptInvitePage({ token }: Props) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const mode = useAuthStore((s) => s.mode);

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

  // Verify the token on mount
  useEffect(() => {
    api.verifyInviteLink(token).then((result) => {
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
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setFormLoading(true);

    try {
      // Register + join org via server-side endpoint (bypasses disableSignUp)
      const result = await api.registerViaInvite({
        token,
        username,
        password,
        displayName: displayName || undefined,
      });

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
        setFormLoading(false);
      }
    } catch (err: any) {
      setFormError(err.message || 'Registration failed');
      setFormLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setFormLoading(true);

    try {
      const result = await authClient.signIn.username({
        username,
        password,
      });

      if (result.error) {
        setFormError(result.error.message || 'Login failed');
        setFormLoading(false);
        return;
      }

      const u = result.data?.user as any;
      if (u) {
        useAuthStore.setState({
          isAuthenticated: true,
          user: {
            id: u.id,
            username: u.username || u.name || 'user',
            displayName: u.name || u.username || 'User',
            role: u.role || 'user',
          },
        });
      }

      // Now accept the invite
      await acceptInvite();
    } catch (err: any) {
      setFormError(err.message || 'Login failed');
      setFormLoading(false);
    }
  };

  const handleContinue = () => {
    window.location.href = '/';
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-card p-8 shadow-lg text-center">
        {/* Verifying token */}
        {step === 'verifying' && (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Verifying invite link...</p>
          </>
        )}

        {/* Registration / Login form */}
        {step === 'register' && (
          <>
            <UserPlus className="mx-auto h-8 w-8 text-primary" />
            <div>
              <h2 className="text-lg font-semibold text-foreground">Join {orgName}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                You've been invited as <span className="font-medium">{role}</span>.{' '}
                {isLoginMode ? 'Sign in to accept.' : 'Create an account to get started.'}
              </p>
            </div>

            <form
              onSubmit={isLoginMode ? handleLogin : handleRegister}
              className="space-y-4 text-left"
            >
              <div className="space-y-2">
                <label htmlFor="invite-username" className="text-sm font-medium text-foreground">
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
                    className="text-sm font-medium text-foreground"
                  >
                    Display Name
                    <span className="ml-1 text-muted-foreground font-normal">(optional)</span>
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
                <label htmlFor="invite-password" className="text-sm font-medium text-foreground">
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

              {formError && <p className="text-sm text-destructive">{formError}</p>}

              <Button
                type="submit"
                className="w-full"
                disabled={formLoading || !username || !password}
                data-testid="invite-submit"
              >
                {formLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {isLoginMode ? 'Sign In & Join' : 'Create Account & Join'}
              </Button>
            </form>

            <p className="text-sm text-muted-foreground">
              {isLoginMode ? (
                <>
                  Don't have an account?{' '}
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => {
                      setIsLoginMode(false);
                      setFormError('');
                    }}
                    data-testid="invite-switch-register"
                  >
                    Register
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{' '}
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => {
                      setIsLoginMode(true);
                      setFormError('');
                    }}
                    data-testid="invite-switch-login"
                  >
                    Sign in
                  </button>
                </>
              )}
            </p>
          </>
        )}

        {/* Accepting invite */}
        {step === 'accepting' && (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Joining {orgName}...</p>
          </>
        )}

        {/* Success */}
        {step === 'success' && (
          <>
            <CheckCircle2 className="mx-auto h-8 w-8 text-green-500" />
            <h2 className="text-lg font-semibold text-foreground">You're in!</h2>
            <p className="text-sm text-muted-foreground">
              You've successfully joined <span className="font-medium">{orgName}</span>.
            </p>
            <Button onClick={handleContinue} className="w-full" data-testid="invite-continue">
              Continue to App
            </Button>
          </>
        )}

        {/* Already a member */}
        {step === 'already' && (
          <>
            <CheckCircle2 className="mx-auto h-8 w-8 text-blue-500" />
            <h2 className="text-lg font-semibold text-foreground">Already a member</h2>
            <p className="text-sm text-muted-foreground">
              You're already a member of <span className="font-medium">{orgName}</span>.
            </p>
            <Button onClick={handleContinue} className="w-full" data-testid="invite-continue">
              Continue to App
            </Button>
          </>
        )}

        {/* Error */}
        {step === 'error' && (
          <>
            <XCircle className="mx-auto h-8 w-8 text-destructive" />
            <h2 className="text-lg font-semibold text-foreground">Invitation failed</h2>
            <p className="text-sm text-muted-foreground">{errorMessage}</p>
            <Button
              variant="outline"
              onClick={handleContinue}
              className="w-full"
              data-testid="invite-continue"
            >
              Go to App
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
