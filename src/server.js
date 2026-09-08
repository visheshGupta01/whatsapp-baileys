import express from 'express';
import http from 'node:http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { Server } from 'socket.io';
import { env } from './config.js';
import { logger } from './logger.js';
import { authMiddleware } from './middleware/auth.js';
import { WhatsAppManager } from './services/whatsapp.js';
import { createWhatsappRouter } from './routes/whatsapp.js';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map(s => s.trim()),
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map(s => s.trim()),
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'baileys-backend' }));

const manager = new WhatsAppManager(io);
app.use('/api/wa', authMiddleware, createWhatsappRouter(manager));

io.use((socket, next) => {
  // Socket.IO auth is deliberately lightweight here. For production browser apps,
  // pass a Supabase access token and validate it with supabase.auth.getUser().
  next();
});

io.on('connection', socket => {
  socket.on('whatsapp.join', ({ sessionId }) => {
    if (sessionId) socket.join(`wa:${sessionId}`);
  });
});

app.use((err, _req, res, _next) => {
  logger.error({ err }, 'request failed');
  const status = err?.statusCode || err?.status || 500;
  res.status(status).json({
    error: status === 500 ? 'internal_server_error' : 'request_error',
    message: env.NODE_ENV === 'production' && status === 500 ? 'Internal server error' : err.message,
  });
});

const shutdown = async signal => {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(env.PORT, async () => {
  logger.info({ port: env.PORT }, 'HTTP server listening');
  try {
    await manager.restorePersistedSessions();
  } catch (err) {
    logger.error({ err }, 'failed to restore persisted WhatsApp sessions');
  }
});
