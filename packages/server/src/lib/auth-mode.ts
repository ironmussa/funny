export type AuthMode = 'local' | 'multi';

export function getAuthMode(): AuthMode {
  const mode = process.env.AUTH_MODE?.toLowerCase();
  return mode === 'multi' ? 'multi' : 'local';
}
