import winston from 'winston';
import { AbbacchioWinstonTransport } from '@abbacchio/transport/transports/winston';
import { emitLog } from '@funny/observability';

const url = process.env.ABBACCHIO_URL || 'http://localhost:4000/api/logs';
const channel = process.env.ABBACCHIO_CHANNEL || 'funny-server';
const isDev = process.env.NODE_ENV !== 'production';

/** Winston transport that forwards logs to OTLP via the observability package. */
class OtelTransport extends winston.Transport {
  log(info: any, callback: () => void) {
    const { level, message, namespace, service, timestamp, ...rest } = info;
    const otelLevel = level === 'warn' ? 'warn'
      : level === 'error' ? 'error'
      : level === 'debug' ? 'debug'
      : 'info';
    const attrs: Record<string, string> = {};
    if (namespace) attrs['log.namespace'] = String(namespace);
    if (service) attrs['service.name'] = String(service);
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined && v !== null && k !== 'splat') {
        attrs[k] = String(v);
      }
    }
    emitLog(otelLevel, String(message), attrs);
    callback();
  }
}

export const log = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
  ),
  defaultMeta: { service: 'funny-server' },
  transports: [
    new AbbacchioWinstonTransport({ url, channel }),
    new OtelTransport(),
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
