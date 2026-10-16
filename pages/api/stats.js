import { authenticateRequest, supabaseAdmin, MASTER_PRINCIPAL } from '../../lib/server';

const STATS_DEADLINE_MS = 6000;
const STATS_SETTING_KEYS = [
  'chat_provider', 'chat_model', 'last_auto_sync_at', 'last_manual_sync_at',
  'last_auto_sync_summary', 'last_sync_summary', 'notices_indexed_at',
  'notices_domain_all', 'notices_access_emails', 'notices_enabled', 'notice_lab_emails',
  'audit_access_emails'
];

async function withinDeadline(query, fallback = { data: null, error: { message: 'Health check timed out.' } }) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(query).catch((error) => ({ data: null, error })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), STATS_DEADLINE_MS); })
    ]);
  } finally { clearTimeout(timer); }
}

function settingMap(result) {
  return new Map((result?.data || []).map((row) => [String(row.key), row.value]));
}

function permittedFromSettings(access, settings) {
  const email = String(access?.email || '').trim().toLowerCase();
  const admin = access?.role === 'admin';
  const noticesEnabled = String(settings.get('notices_enabled') ?? 'true').toLowerCase() !== 'false';
  const noticeList = String(settings.get('notices_access_emails') || settings.get('notice_lab_emails') || 'faiyaz@nextventures.io')
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const noticeDomain = String(settings.get('notices_domain_all') || '').toLowerCase() === 'true';
  const canReadNotices = admin || (noticesEnabled && (noticeList.includes(email) || (noticeDomain && email.endsWith('@nextventures.io'))));
  const auditList = String(settings.get('audit_access_emails') ?? 'faiyaz@nextventures.io')
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const canAuditConversations = access?.authProvider === 'master_password' || email === String(MASTER_PRINCIPAL).toLowerCase() ||
    (email.endsWith('@nextventures.io') && auditList.includes(email));
  return { canReadNotices, canAuditConversations };
}

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
    // The overview previously made many serial setting reads through getKeys
    // and sync helpers. One slow optional query held the entire rail for 20–30s.
    // Fetch every independent value in parallel and cap health checks so the
    // workspace remains responsive during a transient Supabase slowdown.
    const [articles, queued, chunks, latest, disputes, databaseHealth, settingsResult, noticeResult] = await Promise.all([
      withinDeadline(sb.from('articles').select('*', { count: 'exact', head: true })),
      withinDeadline(sb.from('articles').select('*', { count: 'exact', head: true }).eq('needs_index', true)),
      withinDeadline(sb.from('chunks').select('*', { count: 'exact', head: true })),
      withinDeadline(sb.from('articles').select('intercom_id,title,url,updated_at,last_indexed_at').not('last_indexed_at', 'is', null).order('last_indexed_at', { ascending: false }).order('intercom_id', { ascending: true }).limit(1)),
      withinDeadline(sb.from('disputes').select('*', { count: 'exact', head: true }).eq('status', 'pending')),
      withinDeadline(sb.rpc('get_database_health')),
      withinDeadline(sb.from('settings').select('key,value').in('key', STATS_SETTING_KEYS)),
      withinDeadline(sb.from('notices').select('title,posted_by,posted_at,source_url,updated_at').order('posted_at', { ascending: false }).limit(1))
    ]);
    const settings = settingMap(settingsResult);
    const permissions = permittedFromSettings(access, settings);
    let lastSyncSummary = null;
    try { lastSyncSummary = JSON.parse(settings.get('last_auto_sync_summary') || settings.get('last_sync_summary') || 'null'); } catch { lastSyncSummary = null; }
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
      noticesUpdatedAt: settings.get('notices_indexed_at') || null,
      latestNotice: permissions.canReadNotices ? (noticeResult?.data?.[0] || null) : null,
      lastSyncAt: settings.get('last_auto_sync_at') || null,
      lastManualSyncAt: settings.get('last_manual_sync_at') || null,
      lastSyncSummary,
      pendingDisputes: access.role === 'admin' ? (disputes.count || 0) : undefined,
      canAuditConversations: permissions.canAuditConversations,
      answerProvider: settings.get('chat_provider') === 'groq' ? 'groq' : settings.get('chat_provider') === 'gemini' ? 'gemini' : 'openai',
      answerModel: settings.get('chat_model') || 'gpt-4o',
      automaticFallback: false,
      storageHealth: databaseHealthReading(databaseHealth),
      storageHealthStatus: databaseHealth.error ? (databaseHealth.error.code === 'PGRST202' || databaseHealth.error.code === '42883' ? 'setup_required' : 'unavailable') : databaseHealthReading(databaseHealth) ? 'ready' : 'unavailable',
      healthy: !articles.error && !chunks.error && !queued.error
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
