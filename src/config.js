import 'dotenv/config';

const bool = (v, fallback) => v == null ? fallback : ['1','true','yes','on'].includes(String(v).toLowerCase());
const num = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: num(process.env.PORT, 3000),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? '*',
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  REQUIRE_SUPABASE_AUTH: bool(process.env.REQUIRE_SUPABASE_AUTH, true),
  WA_BROWSER_NAME: process.env.WA_BROWSER_NAME ?? 'Baileys-Backend',
  WA_SYNC_FULL_HISTORY: bool(process.env.WA_SYNC_FULL_HISTORY, true),
  WA_MARK_ONLINE: bool(process.env.WA_MARK_ONLINE, false),
  WA_QR_TIMEOUT_MS: num(process.env.WA_QR_TIMEOUT_MS, 60000),
  WA_MEDIA_BUCKET: process.env.WA_MEDIA_BUCKET ?? 'whatsapp-media',
  WA_MEDIA_RETENTION_DAYS: num(process.env.WA_MEDIA_RETENTION_DAYS, 0),
  WA_MAX_MEDIA_BYTES: num(process.env.WA_MAX_MEDIA_BYTES, 50 * 1024 * 1024),
  PERSIST_RECEIVED_MEDIA: bool(process.env.PERSIST_RECEIVED_MEDIA, true),
};

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}
