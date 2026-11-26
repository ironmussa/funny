/** Login form of the native app. */

import { eventValue, Input } from '@funny/gpuix-ui/input';
import { whilePending } from '@funny/shared/while-pending';
import { useState } from 'react';

import type { NativeApplicationServices } from '../application';
import { NativeButton, useNativeColors } from './hooks';

export function LoginView({ application }: { application: NativeApplicationServices }) {
  const colors = useNativeColors();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (submittedPassword = password, submittedUsername = username) => {
    if (!submittedUsername.trim() || !submittedPassword || pending) return;
    setError(null);
    await whilePending(setPending, async () => {
      try {
        await application.signIn(submittedUsername.trim(), submittedPassword);
        setPassword('');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  };
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        width: 420,
        padding: 24,
      }}
    >
      <text style={{ fontSize: 24, fontWeight: 'bold' }}>Sign in to Funny</text>
      <Input
        value={username}
        placeholder="Username"
        autoFocus
        readOnly={pending}
        onValueChange={setUsername}
        onSubmit={(event) => void submit(password, eventValue(event))}
      />
      <Input
        value={password}
        placeholder="Password"
        readOnly={pending}
        onValueChange={setPassword}
        onSubmit={(event) => void submit(eventValue(event))}
      />
      <text style={{ color: colors.warning, fontSize: 12 }}>
        GPUIX does not expose secure-text entry; use this experimental login only in a trusted
        environment.
      </text>
      {error ? <text style={{ color: colors.danger }}>{error}</text> : null}
      <NativeButton
        onPress={() => {
          void submit();
        }}
        disabled={pending || !username.trim() || !password}
        testId="login-submit"
      >
        <text>{pending ? 'Signing in…' : 'Sign in'}</text>
      </NativeButton>
    </div>
  );
}
