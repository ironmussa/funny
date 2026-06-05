import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/stores/auth-store';

export function LoginPage() {
  const { t } = useTranslation();
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
    } catch (err: any) {
      setError(err.message || t('auth.loginFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-background flex min-h-screen items-center justify-center">
      <div className="border-border bg-card w-full max-w-sm space-y-6 rounded-lg border p-8 shadow-lg">
        <div className="text-center">
          <h1 className="text-foreground text-2xl font-semibold">{t('app.title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t('auth.signInPrompt')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="username" className="text-foreground text-sm font-medium">
              {t('auth.username')}
            </label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('auth.usernamePlaceholder')}
              autoFocus
              required
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-foreground text-sm font-medium">
              {t('auth.password')}
            </label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('auth.passwordPlaceholder')}
              required
            />
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading || !username || !password}>
            {loading ? t('auth.signingIn') : t('auth.signIn')}
          </Button>
        </form>
      </div>
    </div>
  );
}
