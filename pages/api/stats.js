import { authenticateRequest, supabaseAdmin, getKeys, getLastSyncMarkers } from '../../lib/server';
import { noticesAccess } from '../../lib/notices';
import { canUseAudits } from '../../lib/audits';

export function databaseHealthReading(response) {
  const row = Array.isArray(response?.data) ? response.data[0] : response?.data;
  const bytes = Number(row?.database_bytes);
  const limit = Number(row?.database_limit_bytes);
  if (response?.error || !Number.isSafeInteger(bytes) || bytes < 1) return null;
  const validLimit = Number.isSafeInteger(limit) && limit > 0;
  return { databaseBytes: bytes, databaseLimitBytes: validLimit ? limit : null,
    percentUsed: validLimit ? (bytes / limit) * 100 : null };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    const sb = supabaseAdmin();
    const canReadNotices = access.role === 'admin' || await noticesAccess(access, sb);
    const canAuditConversations = await canUseAudits(access, sb);
    const noticeResult = canReadNotices ? await sb.from('notices').select('title,posted_by,posted_at,source_url,updated_at').order('posted_at', { ascending: false }).limit(1) : null;
    const [articles, queued, chunks, latest, disputes, keys, syncMarkers, databaseHealth, noticesUpdated] = await Promise.all([
      sb.from('articles').select('*', { count: 'exact', head: true }),
      sb.from('articles').select('*', { count: 'exact', head: true }).eq('needs_index', true),
      sb.from('chunks').select('*', { count: 'exact', head: true }),
      sb.from('articles').select('intercom_id,title,url,updated_at,last_indexed_at').not('last_indexed_at', 'is', null).order('last_indexed_at', { ascending: false }).order('intercom_id', { ascending: true }).limit(1),
      sb.from('disputes').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      getKeys(),
      getLastSyncMarkers(sb),
      sb.rpc('get_database_health'),
      sb.from('settings').select('value').eq('key', 'notices_indexed_at').maybeSingle()
    ]);
    const latestFaq = latest.data?.[0] || null;
    if (latestFaq?.updated_at) {
      const raw = latestFaq.updated_at;
      const date = /^\d+$/.test(String(raw)) ? new Date(Number(raw) * (Number(raw) < 1e12 ? 1000 : 1)) : new Date(raw);
      latestFaq.updated_at = Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    return res.status(200).json({
      totalArticles: articles.count || 0,
      queuedArticles: queued.count || 0,
      indexedArticles: Math.max(0, (articles.count || 0) - (queued.count || 0)),
      totalChunks: chunks.count || 0,
      lastUpdatedAt: latest.data?.[0]?.last_indexed_at || null,
      latestFaq,
      noticesUpdatedAt: noticesUpdated?.data?.value || null,
      latestNotice: noticeResult?.data?.[0] || null,
      lastSyncAt: syncMarkers.lastAutoSyncAt || null,
      lastManualSyncAt: syncMarkers.lastManualSyncAt || null,
      lastSyncSummary: syncMarkers.lastSummary || null,
      pendingDisputes: access.role === 'admin' ? (disputes.count || 0) : undefined,
      canAuditConversations,
      answerProvider: keys.chatProvider,
      answerModel: keys.chatModel,
      automaticFallback: false,
      storageHealth: databaseHealthReading(databaseHealth),
      storageHealthStatus: databaseHealth.error ? (databaseHealth.error.code === 'PGRST202' || databaseHealth.error.code === '42883' ? 'setup_required' : 'unavailable') : databaseHealthReading(databaseHealth) ? 'ready' : 'unavailable',
      healthy: !articles.error && !chunks.error && !queued.error
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
