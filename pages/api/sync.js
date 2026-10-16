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
      const [queueResult, totalResult] = await Promise.all([
        sb.from('articles').select('*', { count: 'exact', head: true }).eq('needs_index', true),
        sb.from('articles').select('*', { count: 'exact', head: true })
      ]);
      if (queueResult.error) throw new Error('Could not inspect the sync queue: ' + queueResult.error.message);
      if (totalResult.error) throw new Error('Could not inspect saved articles: ' + totalResult.error.message);
      return res.status(200).json({
        phase: (queueResult.count || 0) > 0 ? 'indexing' : 'detecting',
        queued: queueResult.count || 0,
        stored: totalResult.count || 0,
        checkedAt: new Date().toISOString()
      });
    }

    const { intercomToken, openaiKey, geminiKeys, embeddingProvider } = await getKeys();
    if (!intercomToken) return res.status(400).json({ error: 'No Intercom key saved yet. Add it in Admin first.' });
    const hasEmbeddingKey = embeddingProvider === 'gemini' ? (geminiKeys && geminiKeys.length > 0) : !!openaiKey;
    if (!hasEmbeddingKey) return res.status(400).json({ error: embeddingProvider === 'gemini' ? 'No Gemini keys saved yet. Add them in Admin first.' : 'No OpenAI key saved yet. Add it in Admin first.' });

    const sb = supabaseAdmin();
    let result = await withSyncLease(sb, 'manual', () => syncStep(sb, { intercomToken, openaiKey, geminiKeys, embeddingProvider }));
    if (result.locked) return res.status(202).json({ phase: 'waiting', done: false, ...result });
    // When this browser run performed the comparison that created the queue,
    // draining that exact saved queue is completion. Do not download all 2,000+
    // Intercom articles a second time merely to rediscover the same snapshot.
    if (result.phase === 'indexing' && result.remaining === 0 && req.body?.comparisonCompleted === true) {
      result = { ...result, phase: 'complete', done: true, comparisonConfirmed: true, verificationSkipped: 'current_run_snapshot' };
    }
    // The interactive checker makes several small requests. Record a manual
    // completion only after its final no-difference verification pass, so the
    // homepage never mistakes a half-finished batch for a completed update.
    if (result.done) {
      const finishedAt = new Date().toISOString();
      const run = req.body?.run && typeof req.body.run === 'object' ? req.body.run : {};
      const changed = Math.max(0, Number(run.newFound || 0) + Number(run.updatedFound || 0), Number(result.changedFound || 0));
      const indexed = Math.max(0, Number(run.processed || 0) + Number(result.processed || 0));
      const deleted = Math.max(0, Number(run.deleted || 0), Number(result.deleted || 0));
      const scanned = Math.max(0, Number(run.scanned || 0), Number(result.scanned || 0));
      const chunksWritten = Math.max(0, Number(run.chunks || 0) + Number(result.chunkCount || 0));
      const startedAt = Number.isFinite(Date.parse(run.startedAt)) ? new Date(run.startedAt).toISOString() : finishedAt;
      const summary = { at: finishedAt, trigger: 'manual', status: 'success', changed, indexed, deleted };
      const { error: markerError } = await sb.from('settings').upsert([
        { key: 'last_manual_sync_at', value: finishedAt },
        { key: 'last_manual_sync_summary', value: JSON.stringify(summary) }
      ]);
      if (markerError) throw new Error('Saving the manual completion marker failed: ' + markerError.message);
      try {
        await sb.from('sync_logs').insert({
          trigger: 'manual', status: 'success', started_at: startedAt, finished_at: finishedAt,
          duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)), articles_scanned: scanned,
          articles_changed: changed, articles_deleted: deleted, articles_indexed: indexed,
          chunks_written: chunksWritten, steps: Math.max(1, Number(run.steps || 0) + 1),
          sample_titles: Array.isArray(run.titles) ? run.titles.slice(0, 8) : (result.sampleTitles || []), error: null
        });
        await sb.from('sync_logs').delete().lt('started_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
      } catch { /* history logging must never erase a successful completion */ }
      result = { ...result, runSummary: summary };
    }
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
