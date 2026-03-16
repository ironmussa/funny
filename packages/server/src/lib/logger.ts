/**
 * Server logger — Winston with Abbacchio OTLP transport + daily file rotation.
 *
 * Mirrors the runtime logger pattern so server logs also appear in Abbacchio
 * under the service name "funny-server".
 */

import { mkdirSync } from 'fs';
import { resolve } from 'path';

import 'winston-daily-rotate-file';
import { AbbacchioWinstonTransport } from '@abbacchio/transport';
import winston from 'winston';

import { DATA_DIR } from './data-dir.js';

const isDev = process.env.NODE_ENV !== 'production';
const SERVICE_NAME = 'funny-server';

// Ensure log directory exists
const logDir = resolve(DATA_DIR, 'logs');
mkdirSync(logDir, { recursive: true });

const endpoint = process.env.OTLP_ENDPOINT || 'http://localhost:4000';
const otlpEnabled = !!process.env.OTLP_ENDPOINT;

export const log = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
  ),
  defaultMeta: { service: SERVICE_NAME },
  transports: [
    new AbbacchioWinstonTransport({
      endpoint,
      serviceName: SERVICE_NAME,
      enabled: otlpEnabled,
    }),
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
