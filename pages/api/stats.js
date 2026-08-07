import { authenticateRequest, supabaseAdmin, getKeys, getLastSyncMarkers } from '../../lib/server';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    const sb = supabaseAdmin();
    const [articles, queued, chunks, latest, disputes, keys, syncMarkers] = await Promise.all([
      sb.from('articles').select('*', { count: 'exact', head: true }),
      sb.from('articles').select('*', { count: 'exact', head: true }).eq('needs_index', true),
      sb.from('chunks').select('*', { count: 'exact', head: true }),
      sb.from('articles').select('last_indexed_at').not('last_indexed_at', 'is', null).order('last_indexed_at', { ascending: false }).limit(1),
      sb.from('disputes').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      getKeys(),
      getLastSyncMarkers(sb)
    ]);
    return res.status(200).json({
      totalArticles: articles.count || 0,
      queuedArticles: queued.count || 0,
      indexedArticles: Math.max(0, (articles.count || 0) - (queued.count || 0)),
      totalChunks: chunks.count || 0,
      lastUpdatedAt: latest.data?.[0]?.last_indexed_at || null,
      lastSyncAt: syncMarkers.lastAutoSyncAt || null,
      lastSyncSummary: syncMarkers.lastSummary || null,
      pendingDisputes: access.role === 'admin' ? (disputes.count || 0) : undefined,
      answerProvider: keys.chatProvider,
      answerModel: keys.chatModel,
      automaticFallback: false,
      healthy: !articles.error && !chunks.error && !queued.error
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
