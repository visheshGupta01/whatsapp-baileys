import pino from 'pino';
import { env } from './config.js';

const targets = [
  {
    target: 'pino/file',
    level: env.LOG_LEVEL,
    options: {
      destination: 'logs/baileys.log',
      mkdir: true,
    },
  },
];

if (env.NODE_ENV !== 'production') {
  targets.unshift({
    target: 'pino-pretty',
    level: env.LOG_LEVEL,
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  });
}

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: { targets },
  base: { service: 'baileys-backend' },
  redact: {
    paths: ['req.headers.authorization', 'authorization', 'token', 'qr', 'creds', 'authState'],
    censor: '[REDACTED]',
  },
});
