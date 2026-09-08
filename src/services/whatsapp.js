import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  isJidNewsletter,
  getContentType,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { EventEmitter } from 'node:events';
import NodeCache from '@cacheable/node-cache';
import { createDbAuthState } from '../auth.js';
import { logger } from '../logger.js';
import { env } from '../config.js';
import {
  getSession, getMessage, upsertContacts, upsertChats, upsertMessages,
  upsertGroups, persistHistory, upsertSession
} from './repository.js';
import { persistIncomingMedia } from './media.js';

class TTLCache {
  constructor(ttl = 300_000) { this.ttl = ttl; this.map = new Map(); }
  get(k) { const x = this.map.get(k); if (!x) return undefined; if (Date.now() > x.exp) { this.map.delete(k); return undefined; } return x.v; }
  set(k, v) { this.map.set(k, { v, exp: Date.now() + this.ttl }); return v; }
  delete(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

class SessionRuntime {
  constructor(sessionId, io) {
    this.sessionId = sessionId;
    this.io = io;
    this.sock = null;
    this.qr = null;
    this.status = 'idle';
    this.lastError = null;
    this.connecting = false;
    this.stopRequested = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.groupCache = new TTLCache(5 * 60_000);
    this.events = new EventEmitter();
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      status: this.status,
      qrAvailable: !!this.qr,
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
      connectedJid: this.sock?.user?.id ?? null,
    };
  }

  emit(name, payload) {
    this.events.emit(name, payload);
    this.io?.to(`wa:${this.sessionId}`).emit(`whatsapp.${name}`, payload);
  }

  async start() {
    if (this.connecting || this.status === 'open') return this.snapshot();
    this.stopRequested = false;
    this.connecting = true;
    this.status = 'connecting';
    await upsertSession(this.sessionId, { status: 'connecting', last_error: null });

    try {
      const { state, saveCreds } = await createDbAuthState(this.sessionId);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

      const loggerChild = logger.child({ component: 'baileys', sessionId: this.sessionId });
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        logger: loggerChild,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, loggerChild),
        },
        browser: Browsers.macOS(env.WA_BROWSER_NAME),
        syncFullHistory: env.WA_SYNC_FULL_HISTORY,
        markOnlineOnConnect: env.WA_MARK_ONLINE,
        qrTimeout: env.WA_QR_TIMEOUT_MS,
        connectTimeoutMs: 20_000,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
        generateHighQualityLinkPreview: false,
        msgRetryCounterCache: new NodeCache({ stdTTL: 10 * 60, useClones: false }),
        cachedGroupMetadata: async jid => this.groupCache.get(jid),
        shouldIgnoreJid: jid => isJidBroadcast(jid) || isJidNewsletter(jid),
        getMessage: async key => getMessage(this.sessionId, key),
      });

      this.sock = sock;
      this.qr = null;

      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
        } catch (err) {
          logger.error({ err, sessionId: this.sessionId }, 'credential persistence failed');
        }
      });

      this.bindEvents(sock);

      this.connecting = false;
      return this.snapshot();
    } catch (err) {
      this.connecting = false;
      this.status = 'error';
      this.lastError = err.message;
      await upsertSession(this.sessionId, { status: 'error', last_error: err.message }).catch(() => {});
      throw err;
    }
  }

  bindEvents(sock) {
    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;
      if (qr) {
        this.qr = qr;
        this.status = 'qr';
        this.emit('qr', { sessionId: this.sessionId, qr });
        await upsertSession(this.sessionId, { status: 'qr' }).catch(() => {});
      }

      if (connection === 'open') {
        this.status = 'open';
        this.qr = null;
        this.lastError = null;
        this.reconnectAttempt = 0;
        const user = sock.user;
        await upsertSession(this.sessionId, {
          status: 'open',
          jid: user?.id ?? null,
          phone: user?.id?.split(':')[0]?.split('@')[0] ?? null,
          push_name: user?.name ?? null,
          connected_at: new Date().toISOString(),
          last_error: null,
        }).catch(() => {});
        this.emit('connection', { sessionId: this.sessionId, connection, isNewLogin, receivedPendingNotifications });
      }

      if (connection === 'close') {
        this.sock = null;
        this.qr = null;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const badSession = statusCode === DisconnectReason.badSession;
        const replaced = statusCode === DisconnectReason.connectionReplaced;
        this.lastError = lastDisconnect?.error?.message ?? `closed:${statusCode ?? 'unknown'}`;

        if (loggedOut || badSession || replaced || this.stopRequested) {
          this.status = loggedOut ? 'logged_out' : 'closed';
          await upsertSession(this.sessionId, { status: this.status, last_error: this.lastError }).catch(() => {});
          this.emit('connection', { sessionId: this.sessionId, connection, statusCode, shouldReconnect: false });
          return;
        }

        this.status = 'reconnecting';
        this.reconnectAttempt++;
        await upsertSession(this.sessionId, { status: 'reconnecting', last_error: this.lastError }).catch(() => {});
        this.emit('connection', { sessionId: this.sessionId, connection, statusCode, shouldReconnect: true });
        this.scheduleReconnect();
      }
    });

    sock.ev.on('messaging-history.set', async payload => {
      try {
        await persistHistory(this.sessionId, payload);
        this.emit('history', {
          sessionId: this.sessionId,
          chats: payload.chats?.length ?? 0,
          contacts: payload.contacts?.length ?? 0,
          messages: payload.messages?.length ?? 0,
          isLatest: payload.isLatest,
          progress: payload.progress,
        });
      } catch (err) {
        logger.error({ err, sessionId: this.sessionId }, 'history persistence failed');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type, requestId }) => {
      try {
        await upsertMessages(this.sessionId, messages);
        for (const msg of messages) {
          try { await persistIncomingMedia(this.sessionId, msg); }
          catch (err) { logger.warn({ err, sessionId: this.sessionId, messageId: msg.key?.id }, 'media persistence failed'); }
        }
        this.emit('messages.upsert', { sessionId: this.sessionId, messages, type, requestId });
      } catch (err) {
        logger.error({ err, sessionId: this.sessionId }, 'messages.upsert persistence failed');
      }
    });

    sock.ev.on('messages.update', async updates => {
      this.emit('messages.update', { sessionId: this.sessionId, updates });
      // Preserve latest raw message updates where possible.
      for (const u of updates) {
        if (u.key?.id && u.update?.message) {
          await upsertMessages(this.sessionId, [{ key: u.key, message: u.update.message }]).catch(() => {});
        }
      }
    });

    sock.ev.on('messages.delete', payload => this.emit('messages.delete', { sessionId: this.sessionId, payload }));
    sock.ev.on('messages.reaction', payload => this.emit('messages.reaction', { sessionId: this.sessionId, payload }));
    sock.ev.on('message-receipt.update', payload => this.emit('message-receipt.update', { sessionId: this.sessionId, payload }));
    sock.ev.on('messages.media-update', payload => this.emit('messages.media-update', { sessionId: this.sessionId, payload }));
    sock.ev.on('chats.upsert', async chats => {
      await upsertChats(this.sessionId, chats).catch(err => logger.error({ err }, 'chats.upsert persistence failed'));
      this.emit('chats.upsert', { sessionId: this.sessionId, chats });
    });
    sock.ev.on('chats.update', async updates => {
      await upsertChats(this.sessionId, updates).catch(() => {});
      this.emit('chats.update', { sessionId: this.sessionId, updates });
    });
    sock.ev.on('chats.delete', async ids => {
      this.emit('chats.delete', { sessionId: this.sessionId, ids });
    });
    sock.ev.on('contacts.upsert', async contacts => {
      await upsertContacts(this.sessionId, contacts).catch(err => logger.error({ err }, 'contacts persistence failed'));
      this.emit('contacts.upsert', { sessionId: this.sessionId, contacts });
    });
    sock.ev.on('contacts.update', async contacts => {
      await upsertContacts(this.sessionId, contacts).catch(() => {});
      this.emit('contacts.update', { sessionId: this.sessionId, contacts });
    });
    sock.ev.on('groups.upsert', async groups => {
      await upsertGroups(this.sessionId, groups).catch(() => {});
      for (const g of groups) this.groupCache.set(g.id, g);
      this.emit('groups.upsert', { sessionId: this.sessionId, groups });
    });
    sock.ev.on('groups.update', async updates => {
      for (const g of updates) {
        if (g.id) {
          const meta = await sock.groupMetadata(g.id).catch(() => null);
          if (meta) { this.groupCache.set(g.id, meta); await upsertGroups(this.sessionId, [meta]).catch(() => {}); }
        }
      }
      this.emit('groups.update', { sessionId: this.sessionId, updates });
    });
    sock.ev.on('group-participants.update', async update => {
      const meta = await sock.groupMetadata(update.id).catch(() => null);
      if (meta) { this.groupCache.set(update.id, meta); await upsertGroups(this.sessionId, [meta]).catch(() => {}); }
      this.emit('group-participants.update', { sessionId: this.sessionId, update });
    });
    sock.ev.on('presence.update', payload => this.emit('presence.update', { sessionId: this.sessionId, payload }));
    sock.ev.on('blocklist.set', payload => this.emit('blocklist.set', { sessionId: this.sessionId, payload }));
    sock.ev.on('blocklist.update', payload => this.emit('blocklist.update', { sessionId: this.sessionId, payload }));
    sock.ev.on('settings.update', payload => this.emit('settings.update', { sessionId: this.sessionId, payload }));
    sock.ev.on('labels.edit', payload => this.emit('labels.edit', { sessionId: this.sessionId, payload }));
    sock.ev.on('labels.association', payload => this.emit('labels.association', { sessionId: this.sessionId, payload }));
    sock.ev.on('call', payload => this.emit('call', { sessionId: this.sessionId, payload }));
    sock.ev.on('creds.update', () => this.emit('creds.update', { sessionId: this.sessionId }));
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopRequested) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 5));
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try { await this.start(); }
      catch (err) {
        logger.error({ err, sessionId: this.sessionId }, 'reconnect failed');
        this.scheduleReconnect();
      }
    }, delay);
  }

  async send(content, options = {}) {
    if (!this.sock) throw new Error('WhatsApp is not connected');
    return this.sock.sendMessage(options.jid, content, options.options);
  }

  async logout() {
    this.stopRequested = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.sock) {
      try { await this.sock.logout(); } catch {}
      this.sock = null;
    }
    this.status = 'logged_out';
    this.qr = null;
    await upsertSession(this.sessionId, { status: 'logged_out' });
  }

  async getQr() {
    return this.qr;
  }
}

export class WhatsAppManager {
  constructor(io) {
    this.io = io;
    this.sessions = new Map();
  }

  async getOrCreate(sessionId) {
    let runtime = this.sessions.get(sessionId);
    if (!runtime) {
      runtime = new SessionRuntime(sessionId, this.io);
      this.sessions.set(sessionId, runtime);
    }
    return runtime;
  }

  async connect(sessionId) {
    const r = await this.getOrCreate(sessionId);
    await r.start();
    return r;
  }

  async restorePersistedSessions() {
    const { data, error } = await (await import('../supabase.js')).supabase
      .from('wa_sessions').select('id,status');
    if (error) throw error;
    for (const s of data ?? []) {
      if (s.status !== 'logged_out') {
        this.connect(s.id).catch(err => logger.error({ err, sessionId: s.id }, 'restore failed'));
      }
    }
  }

  get(sessionId) { return this.sessions.get(sessionId); }
}
