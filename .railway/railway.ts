import { defineRailway, postgres, project, service, volume } from 'railway/iac';

export default defineRailway(() => {
  const Postgres = postgres('Postgres', { region: 'us-east4-eqdc4a' });
  Postgres.networking = { privateNetworkEndpoint: 'postgres', tcpProxies: { '5432': {} } };
  const funnyRunnerVolume = volume('funny-runner-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-east4-eqdc4a',
    sizeMB: 5000,
  });
  const funnyServerVolumeYHrb = volume('funny-server-volume-YHrb', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-east4-eqdc4a',
    sizeMB: 5000,
  });
  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-east4-eqdc4a',
    sizeMB: 5000,
  });
  // The central server (was railway.json).
  const funnyServer = service('funny-server', {
    build: {
      buildCommand: 'bun run build:server-deploy',
      buildEnvironment: 'V3',
      builder: 'RAILPACK',
    },
    start: 'bun run start:railway',
    healthcheck: '/api/health',
    healthcheckTimeout: 300,
    // Restarts on failure (Railway's default policy), at most 5 times.
    deploy: { restartPolicyMaxRetries: 5 },
    replicas: { 'us-east4-eqdc4a': 1 },
    volumeMounts: { '/data': funnyServerVolumeYHrb },
  });
  // The runner (was railway.runner.json): outbound only, so no healthcheck or domain.
  const funnyRunner = service('funny-runner', {
    build: {
      buildCommand: 'bun run build:runner-deploy',
      buildEnvironment: 'V3',
      builder: 'RAILPACK',
    },
    start: 'sh scripts/start-railway-runner.sh',
    // Restarts on failure, at most 10 times: Railway's defaults, so nothing to set.
    replicas: { 'us-east4-eqdc4a': 1 },
    volumeMounts: { '/data': funnyRunnerVolume },
  });

  return project('funny', {
    variables: { managed: false },
    resources: [
      funnyServer,
      Postgres,
      funnyRunner,
      funnyRunnerVolume,
      funnyServerVolumeYHrb,
      postgresVolume,
    ],
  });
});
