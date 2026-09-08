import pino from 'pino';
import { env } from './config.js';

const transport = env.NODE_ENV !== 'production'
  ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } }
  : undefined;

export const logger = pino({
  level: env.LOG_LEVEL,
  transport,
  base: { service: 'baileys-backend' },
  redact: {
    paths: ['req.headers.authorization', 'authorization', 'token', 'qr', 'creds', 'authState'],
    censor: '[REDACTED]',
  },
});
