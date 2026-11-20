import {
  supabaseAdmin, getKeys, authenticateRequest, runAutoSync, getAutoSyncConfig, withSyncLease
} from '../../lib/server';

// Give the sync loop room to drain work in one invocation. Vercel Pro allows up
// to 300s; on Hobby this is capped at 60s automatically and the run simply
// continues on the next tick.
export const config = { maxDuration: 60 };

// Record every invocation so a missed or rejected scheduled run is visible in
// /api/external/sync-status instead of silently leaving no trace.
async function recordInvocation(sb, patch) {
  try {
    let previous = {};
    try { previous = JSON.parse((await sb.from('settings').select('value').eq('key', 'cron_invocation_v1').maybeSingle()).data?.value || '{}'); } catch { previous = {}; }
    await sb.from('settings').upsert({ key: 'cron_invocation_v1', value: JSON.stringify({ ...previous, ...patch, at: new Date().toISOString() }) });
  } catch { /* observability only */ }
}

// Background draining without an open browser: after a pass that leaves work
// queued, ask this same route to run again. The next invocation is a separate
// serverless function, so the work continues after this one ends.
const MAX_CHAIN_DEPTH = 400;
async function kickNextPass(req, depth) {
  const secret = process.env.CRON_SECRET;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (!secret || !/^[a-z0-9.-]+(:\d+)?$/i.test(host) || depth >= MAX_CHAIN_DEPTH) return false;
  try {
    await fetch(`https://${host}/api/cron-sync`, { method: 'GET', headers: { authorization: `Bearer ${secret}`, 'x-chain-depth': String(depth + 1) }, signal: AbortSignal.timeout(5000) });
  } catch { /* the 5s wait only confirms delivery; the next pass keeps running */ }
  return true;
}

// This endpoint is hit two ways:
//  1) Vercel Cron (scheduled in vercel.json) — authenticated by CRON_SECRET.
//  2) An Admin pressing "Run auto-sync now" — authenticated by their session.
// It self-gates: a brand-new sync cycle only starts once the chosen interval
// has elapsed, but any already-queued indexing work is always drained.
export default async function handler(req, res) {
  const sb = supabaseAdmin();

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = String(req.headers['authorization'] || '');
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  let isAdmin = false;
  if (!isCron) {
    try { const a = await authenticateRequest(req); isAdmin = a?.role === 'admin'; } catch { isAdmin = false; }
  }
  const chainDepth = isCron ? Math.max(0, Math.min(Number(req.headers['x-chain-depth']) || 0, MAX_CHAIN_DEPTH)) : 0;
  if (!isCron && !isAdmin) {
    await recordInvocation(sb, { outcome: 'unauthorized', cronSecretConfigured: !!cronSecret, hadAuthorizationHeader: !!authHeader, userAgent: String(req.headers['user-agent'] || '').slice(0, 60) });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const manual = isAdmin && !isCron;

  try {
    const cfg = await getAutoSyncConfig(sb);
    const { intercomToken, openaiKey, geminiKeys, embeddingProvider, chatProvider, chatModel } = await getKeys();
    const hasEmbeddingKey = embeddingProvider === 'gemini' ? (geminiKeys && geminiKeys.length > 0) : !!openaiKey;
    if (!intercomToken || !hasEmbeddingKey) {
      return res.status(200).json({ ran: false, reason: `Intercom or ${embeddingProvider === 'gemini' ? 'Gemini' : 'OpenAI'} embedding key is not set yet.` });
    }

    const { count: queuedCount } = await sb
      .from('articles').select('*', { count: 'exact', head: true }).eq('needs_index', true);
    const hasQueue = (queuedCount || 0) > 0;

    const last = cfg.lastAutoSyncAt ? Date.parse(cfg.lastAutoSyncAt) : 0;
    const elapsedHours = (Date.now() - last) / 3600000;
    // Grace margin: a scheduled cron that fires a little earlier than a full
    // interval (e.g. a daily 9:00 AM tick when yesterday's run finished at 9:17)
    // should still count, otherwise the schedule drifts to every other day.
    const graceHours = Math.min(1, cfg.intervalHours * 0.1);
    const intervalElapsed = !last || elapsedHours >= (cfg.intervalHours - graceHours);

    // Run if: an Admin asked directly, OR there is leftover work to finish,
    // OR auto-sync is enabled and enough time has passed for a new cycle.
    const shouldRun = manual || hasQueue || (cfg.enabled && intervalElapsed);
    if (!shouldRun) {
      const remaining = Math.max(0, (cfg.intervalHours - graceHours) - elapsedHours);
      return res.status(200).json({
        ran: false,
        reason: cfg.enabled ? `Next automatic sync in about ${remaining.toFixed(1)}h.` : 'Automatic sync is turned off.',
        enabled: cfg.enabled, intervalHours: cfg.intervalHours, lastAutoSyncAt: cfg.lastAutoSyncAt
      });
    }

    // Stay safely under the platform limit while draining as much as possible.
    // Leave room for one final step (up to ~25s) inside the 60s function limit.
    const budgetMs = 32000;
    const trigger = manual ? 'manual' : 'auto';
    const result = await withSyncLease(sb, trigger, () => runAutoSync(sb, { intercomToken, openaiKey, geminiKeys, embeddingProvider, chatProvider, chatModel }, { trigger, budgetMs }));
    if (result.locked) {
      await recordInvocation(sb, { outcome: 'locked', trigger, chainDepth });
      return res.status(202).json({ ran: false, trigger, ...result });
    }
    // Continue in the background while queued work remains and no pause or
    // error stops it. A quota pause, error or empty queue ends the chain.
    let chained = false;
    if (!result.error) {
      const { count } = await sb.from('articles').select('*', { count: 'exact', head: true }).eq('needs_index', true);
      const pause = Date.parse((await sb.from('settings').select('value').eq('key', 'faq_image_quota_cooldown_until').maybeSingle()).data?.value || '');
      const paused = Number.isFinite(pause) && pause > Date.now();
      if ((count || 0) > 0 && !paused) chained = await kickNextPass(req, chainDepth);
    }
    await recordInvocation(sb, { outcome: result.error ? 'error' : 'ok', trigger, chainDepth, chained, error: result.error || null, indexed: result.articlesIndexed ?? null, steps: result.steps ?? null });
    return res.status(200).json({ ran: true, trigger, chained, ...result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
