import {
  jidNormalizedUser,
  jidDecode,
  jidEncode,
  areJidsSameUser,
  isJidGroup,
  isJidNewsletter,
  isJidBroadcast,
} from '@whiskeysockets/baileys';

export {
  jidNormalizedUser,
  jidDecode,
  jidEncode,
  areJidsSameUser,
  isJidGroup,
  isJidNewsletter,
  isJidBroadcast,
};

export function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') throw new Error('jid is required');
  return jidNormalizedUser(jid);
}
