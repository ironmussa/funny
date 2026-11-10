/**
 * Server logger — Winston with Abbacchio OTLP transport + console, and daily
 * file rotation once the host attaches it (`attachFileLogTransport`).
 *
 * Mirrors the runtime logger pattern so server logs also appear in Abbacchio
 * under the service name "funny-server". Importing this module touches no
 * filesystem; the Bun host attaches the file transport at boot.
 */

import { mkdirSync } from 'fs';
import { resolve } from 'path';

import { AbbacchioWinstonTransport } from '@abbacchio/transport';
import 'winston-daily-rotate-file';
import {
  getTelemetryIdentity,
  isTelemetryExportEnabled,
  isTestProcess,
} from '@funny/shared/lib/telemetry-identity';
import winston from 'winston';

import { ensureDataDir } from './data-dir.js';

const isDev = process.env.NODE_ENV !== 'production';
const SERVICE_NAME = 'funny-server';

const endpoint = process.env.OTLP_ENDPOINT || 'http://localhost:4000';
const otlpEnabled = isTelemetryExportEnabled();

const telemetryTransport = new AbbacchioWinstonTransport({
  endpoint,
  serviceName: SERVICE_NAME,
  enabled: otlpEnabled,
  ...getTelemetryIdentity('funny-server'),
});

export const log = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
  ),
  defaultMeta: { service: SERVICE_NAME },
  transports: [
    telemetryTransport,
    ...(isDev
      ? [
          new winston.transports.Console({
            format: winston.format.combine(
              winston.format.colorize(),
              winston.format.printf(({ level, message, timestamp, namespace, ...meta }) => {
                const ns = namespace ? `[${namespace}]` : '';
                const extra =
                  Object.keys(meta).length > 1
                    ? ' ' +
                      JSON.stringify(
                        Object.fromEntries(Object.entries(meta).filter(([k]) => k !== 'service')),
                      )
                    : '';
                return `${timestamp} ${level} ${ns} ${message}${extra}`;
              }),
            ),
          }),
        ]
      : [
          new winston.transports.Console({
            format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
          }),
        ]),
  ],
});

let fileTransportAttached = false;

/**
 * Also write logs to `<data dir>/logs/server-YYYY-MM-DD.log` (7 days kept).
 * Called by the Bun host at boot; a no-op in test processes and when already
 * attached. Returns the log directory, or null when not attached.
 */
export function attachFileLogTransport(): string | null {
  if (isTestProcess() || fileTransportAttached) return null;
  const dir = resolve(ensureDataDir(), 'logs');
  mkdirSync(dir, { recursive: true });
  log.add(
    new winston.transports.DailyRotateFile({
      dirname: dir,
      filename: 'server-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '7d',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp, namespace, ...meta }) => {
          const ns = namespace ? `[${namespace}]` : '';
          const extra =
            Object.keys(meta).length > 1
              ? ' ' +
                JSON.stringify(
                  Object.fromEntries(Object.entries(meta).filter(([k]) => k !== 'service')),
                )
              : '';
          return `${timestamp} ${level} ${ns} ${message}${extra}`;
        }),
      ),
    }),
  );
  fileTransportAttached = true;
  return dir;
}
