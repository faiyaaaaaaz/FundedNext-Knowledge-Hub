import { authenticateRequest, getKeys, supabaseAdmin, syncStep, withSyncLease } from '../../lib/server';

export const config = { maxDuration: 60 };

// Manual sync used by the Admin "Check for updates" console. The client calls
// this repeatedly until `done` is true, showing progress after each call.
// The heavy lifting lives in syncStep() so this route and the automatic
// /api/cron-sync route stay perfectly in step.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    if (req.body?.action === 'status') {
      const sb = supabaseAdmin();
      const { count, error } = await sb.from('articles').select('*', { count: 'exact', head: true }).eq('needs_index', true);
      if (error) throw new Error('Could not inspect the sync queue: ' + error.message);
      return res.status(200).json({
        phase: (count || 0) > 0 ? 'indexing' : 'detecting',
        queued: count || 0,
        checkedAt: new Date().toISOString()
      });
    }

    const { intercomToken, openaiKey } = await getKeys();
    if (!intercomToken) return res.status(400).json({ error: 'No Intercom key saved yet. Add it in Admin first.' });
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key saved yet. Add it in Admin first.' });

    const sb = supabaseAdmin();
    const result = await withSyncLease(sb, 'manual', () => syncStep(sb, { intercomToken, openaiKey }));
    if (result.locked) return res.status(202).json({ phase: 'waiting', done: false, ...result });
    // The interactive checker makes several small requests. Record a manual
    // completion only after its final no-difference verification pass, so the
    // homepage never mistakes a half-finished batch for a completed update.
    if (result.done) {
      const finishedAt = new Date().toISOString();
      await sb.from('settings').upsert([
        { key: 'last_manual_sync_at', value: finishedAt },
        { key: 'last_manual_sync_summary', value: JSON.stringify({ at: finishedAt, trigger: 'manual', status: 'success', changed: 0, indexed: 0, deleted: result.deleted || 0 }) }
      ]);
    }
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
