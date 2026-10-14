import { authenticateRequest, supabaseAdmin } from '../../lib/server';
import { decodeRecoveryUpload, MAX_UPLOAD_BYTES } from '../../lib/diagnosticRecovery';

export const config = { maxDuration: 60, api: { bodyParser: false } };

async function readUpload(req) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) { const error = new Error('Upload a compressed .json.gz report below 3.5 MB.'); error.status = 413; throw error; }
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Sign in again.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    const sb = supabaseAdmin();
    if (req.method === 'GET') {
      const { data, error } = await sb.from('diagnostic_recovery_imports').select('report_hash,exported_at,imported_at,imported_by,summary').order('imported_at', { ascending: false }).limit(10);
      if (error) {
        if (['42P01', 'PGRST205'].includes(error.code)) return res.status(503).json({ error: 'Recovery needs its one-time Supabase SQL setup. Run sql/diagnostic-recovery-and-health.sql, then refresh this section.', setupRequired: true });
        return res.status(502).json({ error: 'Recovery history is temporarily unavailable. Refresh this section shortly.' });
      }
      return res.status(200).json({ imports: data || [] });
    }
    const action = String(req.query.action || 'preview');
    if (!['preview', 'restore'].includes(action)) return res.status(400).json({ error: 'Unknown recovery action.' });
    const bundle = decodeRecoveryUpload(await readUpload(req));
    if (action === 'restore' && req.headers['x-recovery-hash'] !== bundle.reportHash) return res.status(409).json({ error: 'The file changed since it was checked. Check this file again before restoring.' });
    const { data, error } = await sb.rpc('restore_diagnostic_history', { p_bundle: bundle, p_apply: action === 'restore', p_actor: access.email || access.name || 'Master Admin' });
    if (error) {
      if (error.code === 'PGRST202' || /could not find.*function/i.test(error.message || '')) return res.status(503).json({ error: 'Run sql/diagnostic-recovery-and-health.sql once in Supabase SQL Editor, then check this file again.', setupRequired: true });
      // The database RPC runs as one transaction. No partial import is committed.
      return res.status(502).json({ error: `Recovery did not complete. The import transaction was not committed. ${String(error.message || 'Database error').slice(0, 500)}` });
    }
    return res.status(200).json({ ...data, policy: bundle.policy });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'Recovery could not complete. Check the file and try again; repeating a completed import is safe.' });
  }
}
