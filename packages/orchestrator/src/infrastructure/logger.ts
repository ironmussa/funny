import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const isDev = process.env.NODE_ENV !== 'production';

const targets: pino.TransportTargetOptions[] = [];

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
