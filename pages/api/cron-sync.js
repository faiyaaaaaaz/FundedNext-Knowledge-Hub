import {
  supabaseAdmin, getKeys, authenticateRequest, runAutoSync, getAutoSyncConfig
} from '../../lib/server';

// Give the sync loop room to drain work in one invocation. Vercel Pro allows up
// to 300s; on Hobby this is capped at 60s automatically and the run simply
// continues on the next tick.
export const config = { maxDuration: 60 };

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
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });

  const manual = isAdmin && !isCron;

  try {
    const cfg = await getAutoSyncConfig(sb);
    const { intercomToken, openaiKey } = await getKeys();
    if (!intercomToken || !openaiKey) {
      return res.status(200).json({ ran: false, reason: 'Intercom or OpenAI key is not set yet.' });
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
    const budgetMs = 50000;
    const result = await runAutoSync(sb, { intercomToken, openaiKey }, {
      trigger: manual ? 'manual' : 'auto', budgetMs
    });
    return res.status(200).json({ ran: true, trigger: manual ? 'manual' : 'auto', ...result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
