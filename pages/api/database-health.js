import { authenticateRequest, supabaseAdmin } from '../../lib/server';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    const limit = req.body?.databaseLimitMb;
    if (limit !== null && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000000000)) return res.status(400).json({ error: 'Enter a whole number of MB between 1 and 1,000,000,000, or leave blank.' });
    const sb = supabaseAdmin();
    const result = limit === null ? await sb.from('settings').delete().eq('key', 'database_storage_limit_bytes') : await sb.from('settings').upsert({ key: 'database_storage_limit_bytes', value: String(limit * 1000000) });
    if (result.error) throw result.error;
    return res.status(200).json({ ok: true });
  } catch { return res.status(500).json({ error: 'The database allowance could not be saved.' }); }
}
