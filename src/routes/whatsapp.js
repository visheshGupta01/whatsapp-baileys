import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { env } from '../config.js';
import { supabase } from '../supabase.js';
import { normalizeJid } from '../utils/jid.js';
import { createSignedMediaUrl } from '../services/media.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.WA_MAX_MEDIA_BYTES },
});

export function createWhatsappRouter(manager) {
  const router = express.Router();

  const getRuntime = async (req) => {
    const requested = req.params?.sessionId || req.body?.sessionId || req.query?.sessionId;
    const sessionId = requested || req.user?.id;
    if (!sessionId) {
      const e = new Error('sessionId is required');
      e.statusCode = 400;
      throw e;
    }
    if (env.REQUIRE_SUPABASE_AUTH) {
      if (!req.user?.id) {
        const e = new Error('authenticated user is required');
        e.statusCode = 401;
        throw e;
      }
      const { data, error } = await supabase.from('wa_sessions').select('owner_id').eq('id', sessionId).maybeSingle();
      if (error) throw error;
      if (data && data.owner_id && data.owner_id !== req.user.id) {
        const e = new Error('session does not belong to authenticated user'); e.statusCode = 403; throw e;
      }
      if (!data) {
        const { error: ce } = await supabase.from('wa_sessions').insert({ id: sessionId, owner_id: req.user.id, status: 'idle' });
        if (ce && ce.code !== '23505') throw ce;
      }
    }
    return manager.getOrCreate(sessionId);
  };

  router.post('/connect', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      await manager.connect(r.sessionId);
      res.set('Cache-Control', 'no-store');
      res.json(r.snapshot());
    } catch (e) { next(e); }
  });

  router.get('/status', async (req, res, next) => {
    try {
      const sessionId = req.query.sessionId || req.user?.id;
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const r = manager.get(sessionId);
      res.set('Cache-Control', 'no-store');

      if (r) return res.json(r.snapshot());

      const { data, error } = await supabase
        .from('wa_sessions')
        .select('id,status,last_error,jid')
        .eq('id', sessionId)
        .maybeSingle();
      if (error) throw error;

      res.json(data ? {
        sessionId: data.id,
        status: data.status ?? 'disconnected',
        connected: data.status === 'open',
        qrAvailable: false,
        lastError: data.last_error ?? null,
        reconnectAttempt: 0,
        connectedJid: data.jid ?? null,
      } : {
        sessionId,
        status: 'disconnected',
        connected: false,
        qrAvailable: false,
        lastError: null,
        reconnectAttempt: 0,
        connectedJid: null,
      });
    } catch (e) { next(e); }
  });

  router.get('/qr', async (req, res, next) => {
    try {
      const sessionId = req.query.sessionId || req.user?.id;
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const r = manager.get(sessionId);
      if (!r?.qr) return res.status(404).json({ error: 'QR is not currently available' });
      res.set('Cache-Control', 'no-store');
      res.json({ sessionId, qr: r.qr, dataUrl: await QRCode.toDataURL(r.qr) });
    } catch (e) { next(e); }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      await r.logout();
      res.json({ ok: true, ...r.snapshot() });
    } catch (e) { next(e); }
  });

  router.post('/messages/text', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const jid = normalizeJid(req.body.jid);
      const options = req.body.quoted ? { quoted: req.body.quoted } : undefined;
      const result = await r.send({ text: req.body.text }, { jid, options });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/messages/media', upload.single('file'), async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const jid = normalizeJid(req.body.jid);
      const type = req.body.type;
      if (!['image','video','audio','document','sticker'].includes(type)) {
        return res.status(400).json({ error: 'type must be image, video, audio, document, or sticker' });
      }
      let source = req.file?.buffer;
      if (!source && req.body.url) source = { url: req.body.url };
      if (!source) return res.status(400).json({ error: 'multipart file or url is required' });

      const content = { [type]: source };
      if (req.body.caption) content.caption = req.body.caption;
      if (req.body.fileName) content.fileName = req.body.fileName;
      if (req.body.mimetype) content.mimetype = req.body.mimetype;
      if (req.body.ptt === 'true') content.ptt = true;

      const result = await r.send(content, { jid });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/messages/location', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const result = await r.send({
        location: { degreesLatitude: Number(req.body.latitude), degreesLongitude: Number(req.body.longitude), name: req.body.name, address: req.body.address }
      }, { jid: normalizeJid(req.body.jid) });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/messages/contact', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const result = await r.send({ contacts: { displayName: req.body.displayName, contacts: req.body.contacts } }, { jid: normalizeJid(req.body.jid) });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/messages/poll', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const result = await r.send({
        poll: { name: req.body.name, values: req.body.values, selectableCount: req.body.selectableCount ?? 1 }
      }, { jid: normalizeJid(req.body.jid) });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/messages/reaction', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const result = await r.send({ react: { text: req.body.text ?? '', key: req.body.key } }, { jid: normalizeJid(req.body.jid) });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/messages/read', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      await r.sock.readMessages(req.body.keys);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.post('/messages/delete', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const jid = normalizeJid(req.body.jid);
      const result = await r.sock.sendMessage(jid, { delete: req.body.key });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/messages/edit', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const result = await r.sock.sendMessage(normalizeJid(req.body.jid), { text: req.body.text, edit: req.body.key });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/messages/presence', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      await r.sock.sendPresenceUpdate(req.body.presence, normalizeJid(req.body.jid));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.post('/messages/raw', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const result = await r.send(req.body.content, {
        jid: normalizeJid(req.body.jid),
        options: req.body.options,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/history/fetch', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const result = await r.sock.fetchMessageHistory(
        Number(req.body.count || 50),
        req.body.oldestMsgKey,
        Number(req.body.oldestMsgTimestamp || 0),
      );
      res.json({ ok: true, result });
    } catch (e) { next(e); }
  });

  router.post('/contacts/check', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const phones = (req.body.phones || []).map(p => String(p).replace(/\D/g, ''));
      const result = await r.sock.onWhatsApp(...phones);
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/contacts/lids', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      if (typeof r.sock.getLIDsForPNs !== 'function') {
        return res.status(501).json({ error: 'LID mapping helper is not available in this Baileys build' });
      }
      const result = await r.sock.getLIDsForPNs(req.body.jids || []);
      res.json(result);
    } catch (e) { next(e); }
  });

  router.get('/chats', async (req, res, next) => {
    try {
      const sessionId = req.query.sessionId || req.user?.id;
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      let q = supabase.from('wa_chats').select('*').eq('session_id', sessionId)
        .order('conversation_timestamp', { ascending: false });
      const offset = Number(req.query.offset || 0);
      const limit = Math.min(Number(req.query.limit || 50), 100);
      const { data, error } = await q.range(offset, offset + limit - 1);
      if (error) throw error;
      res.json(data ?? []);
    } catch (e) { next(e); }
  });

  router.post('/chats/archive', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      await r.sock.chatModify({ archive: !!req.body.archive }, normalizeJid(req.body.jid));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.post('/chats/mute', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      await r.sock.chatModify({ mute: req.body.muteUntil ? Number(req.body.muteUntil) : null }, normalizeJid(req.body.jid));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.post('/chats/read', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      await r.sock.chatModify({ markRead: !!req.body.read }, normalizeJid(req.body.jid));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.post('/chats/delete', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      await r.sock.chatModify({ delete: true }, normalizeJid(req.body.jid));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.get('/groups/:jid', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const meta = await r.sock.groupMetadata(normalizeJid(req.params.jid));
      res.json(meta);
    } catch (e) { next(e); }
  });

  router.post('/groups', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const result = await r.sock.groupCreate(req.body.subject, (req.body.participants || []).map(normalizeJid));
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/groups/:jid/participants', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const result = await r.sock.groupParticipantsUpdate(normalizeJid(req.params.jid), req.body.participants.map(normalizeJid), req.body.action);
      res.json(result);
    } catch (e) { next(e); }
  });

  router.delete('/groups/:jid/participants', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const result = await r.sock.groupParticipantsUpdate(normalizeJid(req.params.jid), req.body.participants.map(normalizeJid), 'remove');
      res.json(result);
    } catch (e) { next(e); }
  });

  router.patch('/groups/:jid/subject', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      res.json(await r.sock.groupUpdateSubject(normalizeJid(req.params.jid), req.body.subject));
    } catch (e) { next(e); }
  });

  router.patch('/groups/:jid/description', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      res.json(await r.sock.groupUpdateDescription(normalizeJid(req.params.jid), req.body.description));
    } catch (e) { next(e); }
  });

  router.get('/groups/:jid/invite', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      res.json({ code: await r.sock.groupInviteCode(normalizeJid(req.params.jid)) });
    } catch (e) { next(e); }
  });

  router.post('/groups/:jid/leave', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      res.json(await r.sock.groupLeave(normalizeJid(req.params.jid)));
    } catch (e) { next(e); }
  });

  router.get('/privacy', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      res.json(await r.sock.fetchPrivacySettings(true));
    } catch (e) { next(e); }
  });

  router.patch('/privacy', async (req, res, next) => {
    try {
      const r = await getRuntime(req);
      const tasks = [];
      if (req.body.lastSeen) tasks.push(r.sock.updateLastSeenPrivacy(req.body.lastSeen));
      if (req.body.online) tasks.push(r.sock.updateOnlinePrivacy(req.body.online));
      if (req.body.profilePicture) tasks.push(r.sock.updateProfilePicturePrivacy(req.body.profilePicture));
      if (req.body.readReceipts) tasks.push(r.sock.updateReadReceiptsPrivacy(req.body.readReceipts));
      if (req.body.groupsAdd) tasks.push(r.sock.updateGroupsAddPrivacy(req.body.groupsAdd));
      await Promise.all(tasks);
      res.json(await r.sock.fetchPrivacySettings(true));
    } catch (e) { next(e); }
  });

  router.get('/media/url', async (req, res, next) => {
    try {
      const sessionId = req.query.sessionId || req.user?.id;
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const { data, error } = await supabase.from('wa_media').select('storage_path,mime_type,size_bytes,file_name')
        .eq('session_id', sessionId).eq('message_id', req.query.messageId).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'media not found' });
      res.json({ ...data, url: await createSignedMediaUrl(data.storage_path, Number(req.query.expiresIn || 3600)) });
    } catch (e) { next(e); }
  });

  return router;
}
