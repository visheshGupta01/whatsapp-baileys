import { getContentType, normalizeMessageContent } from '@whiskeysockets/baileys';

export function messageText(message) {
  const m = normalizeMessageContent(message?.message);
  if (!m) return null;
  return m.conversation
    ?? m.extendedTextMessage?.text
    ?? m.imageMessage?.caption
    ?? m.videoMessage?.caption
    ?? m.documentMessage?.caption
    ?? m.buttonsResponseMessage?.selectedButtonId
    ?? m.listResponseMessage?.singleSelectReply?.selectedRowId
    ?? null;
}

export function contentType(message) {
  const m = normalizeMessageContent(message?.message);
  return m ? getContentType(m) : null;
}

export function serializeMessage(message) {
  return JSON.stringify(message);
}
