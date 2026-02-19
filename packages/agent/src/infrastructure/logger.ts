import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const isDev = process.env.NODE_ENV !== 'production';

const abbacchioUrl = process.env.ABBACCHIO_URL || 'http://localhost:4000/api/logs';
const abbacchioChannel = process.env.ABBACCHIO_CHANNEL || 'funny-agent';

const targets: pino.TransportTargetOptions[] = [
  {
    target: '@abbacchio/transport/pino',
    options: { url: abbacchioUrl, channel: abbacchioChannel },
    level,
  },
];

if (isDev) {
  targets.push({
    target: 'pino-pretty',
    options: { colorize: true },
    level,
  });
}

export const logger = pino({
  level,
  transport: { targets },
});
