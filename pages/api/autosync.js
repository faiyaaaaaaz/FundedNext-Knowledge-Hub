import {
  authenticateRequest, supabaseAdmin, getAutoSyncConfig, setAutoSyncConfig, getSyncLogs
} from '../../lib/server';

// Admin-only. GET returns the current auto-sync settings + recent run logs.
// POST saves { enabled, intervalHours }.
export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    const sb = supabaseAdmin();

    if (req.method === 'GET') {
      const cfg = await getAutoSyncConfig(sb);
      const logs = await getSyncLogs(sb, 25);
      const { count: queued } = await sb.from('articles').select('*', { count: 'exact', head: true }).eq('needs_index', true);
      return res.status(200).json({
        ...cfg, queued: queued || 0, logs,
        schedulerReady: !!process.env.CRON_SECRET,
        schedulerMessage: process.env.CRON_SECRET
          ? 'Vercel scheduler authentication is configured.'
          : 'Add CRON_SECRET in Vercel Environment Variables, then redeploy. Scheduled calls are currently rejected.'
      });
    }

    if (req.method === 'POST') {
      const { enabled, intervalHours } = req.body || {};
      const cfg = await setAutoSyncConfig({ enabled, intervalHours });
      return res.status(200).json({ ok: true, ...cfg });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
