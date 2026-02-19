import winston from 'winston';
import { AbbacchioWinstonTransport } from '@abbacchio/transport/transports/winston';

const url = process.env.ABBACCHIO_URL || 'http://localhost:4000/api/logs';
const channel = process.env.ABBACCHIO_CHANNEL || 'funny-server';
const isDev = process.env.NODE_ENV !== 'production';

export const log = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
  ),
  defaultMeta: { service: 'funny-server' },
  transports: [
    new AbbacchioWinstonTransport({ url, channel }),
    ...(isDev
      ? [new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ level, message, timestamp, namespace, ...meta }) => {
              const ns = namespace ? `[${namespace}]` : '';
              const extra = Object.keys(meta).length > 1 // 1 = service
                ? ' ' + JSON.stringify(
                    Object.fromEntries(Object.entries(meta).filter(([k]) => k !== 'service')),
                  )
                : '';
              return `${timestamp} ${level} ${ns} ${message}${extra}`;
            }),
          ),
        })]
      : [new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json(),
          ),
        })]),
  ],
});
