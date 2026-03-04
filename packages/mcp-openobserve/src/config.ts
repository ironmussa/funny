export interface OpenObserveConfig {
  baseUrl: string;
  org: string;
  user: string;
  password: string;
  authHeader: string;
}

export function loadConfig(): OpenObserveConfig {
  const baseUrl = (process.env.OPENOBSERVE_URL ?? 'http://localhost:5080').replace(/\/$/, '');
  const org = process.env.OPENOBSERVE_ORG ?? 'default';
  const user = process.env.OPENOBSERVE_USER ?? 'root@example.com';
  const password = process.env.OPENOBSERVE_PASSWORD ?? 'Complexpass#123';
  const authHeader = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

  return { baseUrl, org, user, password, authHeader };
}
