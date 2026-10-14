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

    const { intercomToken, openaiKey, geminiKeys, embeddingProvider } = await getKeys();
    if (!intercomToken) return res.status(400).json({ error: 'No Intercom key saved yet. Add it in Admin first.' });
    const hasEmbeddingKey = embeddingProvider === 'gemini' ? (geminiKeys && geminiKeys.length > 0) : !!openaiKey;
    if (!hasEmbeddingKey) return res.status(400).json({ error: embeddingProvider === 'gemini' ? 'No Gemini keys saved yet. Add them in Admin first.' : 'No OpenAI key saved yet. Add it in Admin first.' });

    const sb = supabaseAdmin();
    const result = await withSyncLease(sb, 'manual', () => syncStep(sb, { intercomToken, openaiKey, geminiKeys, embeddingProvider }));
    if (result.locked) return res.status(202).json({ phase: 'waiting', done: false, ...result });
    // Log every productive indexing batch and every completed detection pass to
    // sync_logs so admins can see a full history. Skip status-only calls.
    if (result.phase === 'indexing' && (result.processed || 0) > 0) {
      const now = new Date().toISOString();
      try {
        await sb.from('sync_logs').insert({
          trigger: 'manual', status: 'partial', started_at: now, finished_at: now,
          duration_ms: result.durationMs || 0, articles_indexed: result.processed || 0,
          chunks_written: result.chunkCount || 0, steps: 1,
          sample_titles: result.sampleTitles || [], error: null
        });
        // Keep only last 7 days of log entries to avoid table bloat
        await sb.from('sync_logs').delete().lt('started_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
      } catch { /* logging must never break the sync */ }
    }
    // The interactive checker makes several small requests. Record a manual
    // completion only after its final no-difference verification pass, so the
    // homepage never mistakes a half-finished batch for a completed update.
    if (result.done) {
      const finishedAt = new Date().toISOString();
      await Promise.all([
        sb.from('settings').upsert([
          { key: 'last_manual_sync_at', value: finishedAt },
          { key: 'last_manual_sync_summary', value: JSON.stringify({ at: finishedAt, trigger: 'manual', status: 'success', changed: result.changedFound || 0, indexed: result.processed || 0, deleted: result.deleted || 0 }) }
        ]),
        sb.from('sync_logs').insert({
          trigger: 'manual', status: 'success', started_at: finishedAt, finished_at: finishedAt,
          duration_ms: result.durationMs || 0, articles_scanned: result.scanned || 0,
          articles_changed: result.changedFound || 0, articles_deleted: result.deleted || 0,
          articles_indexed: result.processed || 0, chunks_written: result.chunkCount || 0,
          steps: 1, sample_titles: result.sampleTitles || [], error: null
        }).catch(() => {})
      ]);
    }
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
