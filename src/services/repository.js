import { supabase } from '../supabase.js';
import { BufferJSON } from '@whiskeysockets/baileys';

const json = (v) => JSON.stringify(v, BufferJSON.replacer);

export async function upsertSession(sessionId, patch) {
  const { error } = await supabase.from('wa_sessions').upsert({
    id: sessionId, ...patch, updated_at: new Date().toISOString()
  }, { onConflict: 'id' });
  if (error) throw error;
}

export async function getSession(sessionId) {
  const { data, error } = await supabase.from('wa_sessions').select('*').eq('id', sessionId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertContacts(sessionId, contacts = []) {
  if (!contacts.length) return;
  const rows = contacts.map(c => ({
    session_id: sessionId, jid: c.id, lid: c.lid ?? null, name: c.name ?? null,
    notify: c.notify ?? null, verified_name: c.verifiedName ?? null,
    img_url: c.imgUrl ?? null, status: c.status ?? null,
    raw: json(c),
    updated_at: new Date().toISOString()
  }));
  const { error } = await supabase.from('wa_contacts').upsert(rows, { onConflict: 'session_id,jid' });
  if (error) throw error;
}

export async function upsertChats(sessionId, chats = []) {
  if (!chats.length) return;
  const rows = chats.map(c => ({
    session_id: sessionId, jid: c.id, name: c.name ?? null, unread_count: c.unreadCount ?? 0,
    conversation_timestamp: c.conversationTimestamp ? Number(c.conversationTimestamp) : null,
    archived: !!c.archived, pinned: !!c.pinned, muted_until: c.muteEndTime ? Number(c.muteEndTime) : null,
    raw: json(c), updated_at: new Date().toISOString()
  }));
  const { error } = await supabase.from('wa_chats').upsert(rows, { onConflict: 'session_id,jid' });
  if (error) throw error;
}

export async function upsertMessages(sessionId, messages = []) {
  if (!messages.length) return;
  const rows = messages.filter(m => m?.key?.id).map(m => ({
    session_id: sessionId,
    id: m.key.id,
    remote_jid: m.key.remoteJid ?? 'unknown',
    participant: m.key.participant ?? null,
    from_me: !!m.key.fromMe,
    message_timestamp: m.messageTimestamp ? Number(m.messageTimestamp) : null,
    push_name: m.pushName ?? null,
    status: m.status ?? null,
    message: m.message ? json(m.message) : null,
    raw: json(m),
    updated_at: new Date().toISOString()
  }));
  if (!rows.length) return;
  const { error } = await supabase.from('wa_messages').upsert(rows, { onConflict: 'session_id,remote_jid,id' });
  if (error) throw error;
}

export async function getMessage(sessionId, key) {
  if (!key?.id) return undefined;
  const { data, error } = await supabase.from('wa_messages').select('message')
    .eq('session_id', sessionId).eq('remote_jid', key.remoteJid ?? 'unknown').eq('id', key.id).maybeSingle();
  if (error || !data?.message) return undefined;
  return JSON.parse(data.message, BufferJSON.reviver);
}

export async function upsertGroups(sessionId, groups = []) {
  if (!groups.length) return;
  const rows = groups.map(g => ({
    session_id: sessionId, jid: g.id, subject: g.subject ?? null,
    subject_owner: g.subjectOwner ?? null, subject_time: g.subjectTime ? Number(g.subjectTime) : null,
    owner: g.owner ?? null, creation: g.creation ? Number(g.creation) : null,
    description: g.desc ?? g.description ?? null, announce: !!g.announce,
    restrict: !!g.restrict, size: g.size ?? null, raw: json(g), updated_at: new Date().toISOString()
  }));
  const { error } = await supabase.from('wa_groups').upsert(rows, { onConflict: 'session_id,jid' });
  if (error) throw error;

  const participants = groups.flatMap(g => (g.participants ?? []).map(p => ({
    session_id: sessionId, group_jid: g.id, jid: p.id, admin: p.admin ?? null,
    is_super_admin: !!p.isSuperAdmin, raw: json(p), updated_at: new Date().toISOString()
  })));
  if (participants.length) {
    const { error: pe } = await supabase.from('wa_group_participants')
      .upsert(participants, { onConflict: 'session_id,group_jid,jid' });
    if (pe) throw pe;
  }
}

export async function persistHistory(sessionId, payload) {
  await upsertContacts(sessionId, payload.contacts);
  await upsertChats(sessionId, payload.chats);
  await upsertMessages(sessionId, payload.messages);
}
