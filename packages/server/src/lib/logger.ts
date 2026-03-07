/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { mkdirSync } from 'fs';
import { resolve } from 'path';

import 'winston-daily-rotate-file';
import { AbbacchioWinstonTransport } from '@abbacchio/transport';
import winston from 'winston';

import { DATA_DIR } from './data-dir.js';
import { getTelemetryConfig } from './telemetry-config.js';

const isDev = process.env.NODE_ENV !== 'production';

// Ensure log directory exists
const logDir = resolve(DATA_DIR, 'logs');
mkdirSync(logDir, { recursive: true });

const cfg = getTelemetryConfig();

export const log = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
  ),
  defaultMeta: { service: cfg.serverServiceName },
  transports: [
    new AbbacchioWinstonTransport({
      endpoint: cfg.endpoint,
      serviceName: cfg.serverServiceName,
      enabled: cfg.enabled,
    }),
    // Persist logs to ~/.funny/logs/server-YYYY-MM-DD.log (rotated daily, 7 days max)
    new winston.transports.DailyRotateFile({
      dirname: logDir,
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
    ...(isDev
      ? [
          new winston.transports.Console({
            format: winston.format.combine(
              winston.format.colorize(),
              winston.format.printf(({ level, message, timestamp, namespace, ...meta }) => {
                const ns = namespace ? `[${namespace}]` : '';
                const extra =
                  Object.keys(meta).length > 1 // 1 = service
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
