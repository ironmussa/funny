export function resolveCorsOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const devClientPort = env.VITE_PORT || '5173';
  const serverPort = env.PORT || '3001';
  const defaultOrigins = [
    `http://localhost:${devClientPort}`,
    `http://127.0.0.1:${devClientPort}`,
    `http://localhost:${serverPort}`,
    `http://127.0.0.1:${serverPort}`,
  ];
  const configuredOrigins =
    env.CORS_ORIGIN?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [];

  return Array.from(new Set([...defaultOrigins, ...configuredOrigins]));
}
