import { supabase } from '../supabase.js';
import { env } from '../config.js';

export async function authMiddleware(req, res, next) {
  if (!env.REQUIRE_SUPABASE_AUTH) {
    req.user = { id: req.header('x-user-id') || 'default-user' };
    return next();
  }

  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'missing bearer token' });

  const token = header.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'invalid access token' });

  req.user = data.user;
  next();
}
