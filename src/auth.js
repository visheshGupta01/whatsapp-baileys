import {
  BufferJSON,
  initAuthCreds,
  proto,
} from '@whiskeysockets/baileys';
import { supabase } from './supabase.js';
import { logger } from './logger.js';

const encode = (value) => JSON.stringify(value, BufferJSON.replacer);
const decode = (value) => value == null ? null : JSON.parse(value, BufferJSON.reviver);

export async function createDbAuthState(sessionId) {
  const { data: credRow, error: credError } = await supabase
    .from('wa_auth_creds')
    .select('data')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (credError) throw credError;

  const creds = credRow?.data ? decode(credRow.data) : initAuthCreds();

  const keys = {
    get: async (type, ids) => {
      if (!ids.length) return {};
      const { data, error } = await supabase
        .from('wa_signal_keys')
        .select('key_id,data')
        .eq('session_id', sessionId)
        .eq('key_type', type)
        .in('key_id', ids);
      if (error) throw error;

      const result = {};
      for (const id of ids) result[id] = undefined;
      for (const row of data ?? []) {
        let value = decode(row.data);
        // App state sync keys need the protobuf object restored exactly as Baileys does.
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        result[row.key_id] = value;
      }
      return result;
    },

    set: async (data) => {
      const upserts = [];
      const deletes = [];

      for (const [type, entries] of Object.entries(data)) {
        for (const [keyId, value] of Object.entries(entries ?? {})) {
          if (value == null) {
            deletes.push([type, keyId]);
          } else {
            upserts.push({
              session_id: sessionId,
              key_type: type,
              key_id: keyId,
              data: encode(value),
            });
          }
        }
      }

      if (upserts.length) {
        const { error } = await supabase
          .from('wa_signal_keys')
          .upsert(upserts, { onConflict: 'session_id,key_type,key_id' });
        if (error) throw error;
      }

      // Deletes are intentionally individual: Signal key churn is usually small and this
      // keeps the implementation portable across Supabase/Postgres client versions.
      for (const [type, keyId] of deletes) {
        const { error } = await supabase
          .from('wa_signal_keys')
          .delete()
          .eq('session_id', sessionId)
          .eq('key_type', type)
          .eq('key_id', keyId);
        if (error) throw error;
      }
    },

    clear: async () => {
      const { error } = await supabase.from('wa_signal_keys').delete().eq('session_id', sessionId);
      if (error) throw error;
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      const { error } = await supabase
        .from('wa_auth_creds')
        .upsert({ session_id: sessionId, data: encode(creds) }, { onConflict: 'session_id' });
      if (error) {
        logger.error({ err: error, sessionId }, 'failed to persist WhatsApp credentials');
        throw error;
      }
    },
  };
}
