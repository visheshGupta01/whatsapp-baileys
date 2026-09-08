import {
  downloadContentFromMessage,
  getContentType,
} from '@whiskeysockets/baileys';
import { supabase } from '../supabase.js';
import { env } from '../config.js';
import { logger } from '../logger.js';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';

async function streamToBuffer(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) throw new Error(`media exceeds ${maxBytes} byte limit`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export async function persistIncomingMedia(sessionId, msg) {
  if (!env.PERSIST_RECEIVED_MEDIA || !msg?.message) return null;
  const type = getContentType(msg.message);
  const media = type && msg.message[type];
  if (!media || !['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'].includes(type)) {
    return null;
  }

  const stream = await downloadContentFromMessage(media, type.replace('Message',''));
  const buffer = await streamToBuffer(stream, env.WA_MAX_MEDIA_BYTES);
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = media.mimetype?.split('/')[1]?.split(';')[0] || 'bin';
  const path = `${sessionId}/${new Date().toISOString().slice(0,10)}/${sha}.${ext}`;

  const { error: uploadError } = await supabase.storage.from(env.WA_MEDIA_BUCKET)
    .upload(path, buffer, { contentType: media.mimetype || 'application/octet-stream', upsert: true });
  if (uploadError) throw uploadError;

  const { error: rowError } = await supabase.from('wa_media').upsert({
    session_id: sessionId,
    message_id: msg.key?.id,
    remote_jid: msg.key?.remoteJid,
    storage_path: path,
    mime_type: media.mimetype,
    size_bytes: buffer.length,
    sha256: sha,
    file_name: media.fileName ?? null,
  }, { onConflict: 'session_id,remote_jid,message_id' });
  if (rowError) throw rowError;

  return { storagePath: path, sizeBytes: buffer.length, mimeType: media.mimetype, sha256: sha };
}

export async function createSignedMediaUrl(storagePath, expiresIn = 3600) {
  const { data, error } = await supabase.storage.from(env.WA_MEDIA_BUCKET).createSignedUrl(storagePath, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

export async function uploadOutgoingBuffer(sessionId, buffer, mimeType, fileName) {
  if (buffer.length > env.WA_MAX_MEDIA_BYTES) throw new Error('media exceeds configured limit');
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = mimeType?.split('/')[1]?.split(';')[0] || 'bin';
  const path = `${sessionId}/outgoing/${sha}.${ext}`;
  const { error } = await supabase.storage.from(env.WA_MEDIA_BUCKET)
    .upload(path, buffer, { contentType: mimeType || 'application/octet-stream', upsert: true });
  if (error) throw error;
  return { storagePath: path, fileName };
}
