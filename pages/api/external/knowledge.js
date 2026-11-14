import { authenticateExternalApiKey } from '../../../lib/externalAccess';
import { getPublishedScopeCatalog, supabaseAdmin } from '../../../lib/server';

// Read-only inventory for diagnosing discovery and indexing with a scoped key.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const access = await authenticateExternalApiKey(req, 'knowledge:read-metadata');
    if (!access) return res.status(401).json({ error: 'A developer API key is required.' });
    const sb = supabaseAdmin();
    const q = String(req.query.q || '').trim().slice(0, 80).replace(/[%_,()]/g, '');
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 100));
    const includeBody = String(req.query.includeBody || '') === 'true';
    const [catalog, scan, articles, notices] = await Promise.all([
      getPublishedScopeCatalog(sb),
      sb.from('settings').select('value').eq('key', 'model_discovery_last_scan').maybeSingle(),
      q ? sb.from('articles').select(includeBody ? 'intercom_id,title,url,state,needs_index,body' : 'intercom_id,title,url,state,needs_index').ilike('title', `%${q}%`).limit(limit) : Promise.resolve({data:[]}),
      q ? sb.from('notices').select('entry_id,title,product,model,status,review_flag,source_url,effective_from,effective_until').ilike('title', `%${q}%`).limit(limit) : Promise.resolve({data:[]})
    ]);
    for (const result of [scan, articles, notices]) if (result.error) throw new Error(result.error.message);
    let lastScan = scan.data?.value || null;
    try { if (typeof lastScan === 'string') lastScan = JSON.parse(lastScan); } catch { lastScan = null; }
    const safeArticles = (articles.data || []).map(article => ({...article, ...(includeBody ? {body:String(article.body || '').slice(0, 15000)} : {})}));
    return res.status(200).json({ generatedAt:new Date().toISOString(), catalog, lastScan, query:q || null, articles:safeArticles, notices:notices.data || [], limit });
  } catch (error) { return res.status(error.status || 500).json({ error:error.message }); }
}
