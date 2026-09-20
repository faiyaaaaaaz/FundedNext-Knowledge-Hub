import { authenticateRequest, supabaseAdmin, getArticleScopeOverrides, getPublishedScopeCatalog } from '../../lib/server';
import { listNotices } from '../../lib/notices';

export const config = { maxDuration: 60, api: { responseLimit: false } };

function productForArticle(article, override) {
  if (override?.product) return override.product;
  const url = String(article.url || '');
  if (/helpfutures\.fundednext\.com/i.test(url)) return 'futures';
  if (/help\.fundednext\.com/i.test(url)) return 'cfd';
  return 'policy';
}

function titleRecord(item) {
  return { id: String(item.intercom_id || item.entry_id), title: String(item.title || 'Untitled'), url: String(item.url || item.source_url || ''), updatedAt: item.updated_at || item.posted_at || item.last_indexed_at || null, status: item.status || 'published' };
}

function addGroup(groups, key, label, product, model, item = null) {
  if (!groups.has(key)) groups.set(key, { id: key, label, product, model, articles: [] });
  if (item) groups.get(key).articles.push(item);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    const sb = supabaseAdmin();
    const [{ data: articles, error }, overrides, catalog, notices] = await Promise.all([
      sb.from('articles').select('intercom_id,title,url,updated_at,last_indexed_at,state').eq('state', 'published').order('title', { ascending: true }).limit(2500),
      getArticleScopeOverrides(sb), getPublishedScopeCatalog(sb), listNotices(sb)
    ]);
    if (error) throw error;
    const modelArticleIds = new Map();
    for (const model of catalog.models || []) for (const article of model.articles || []) {
      const id = String(article.id);
      if (!modelArticleIds.has(id)) modelArticleIds.set(id, model);
    }
    const faqGroups = new Map();
    // Preserve the governed product/account-scope tree even where a scope has
    // no FAQ evidence yet. Hiding it made the explorer look incomplete and
    // obscured gaps that the team needs to see.
    for (const [product, label] of [['cfd', 'General CFD policies'], ['futures', 'General Futures policies'], ['policy', 'Policies & rules']]) {
      addGroup(faqGroups, `${product}:general`, label, product, 'general');
    }
    for (const model of catalog.models || []) {
      if (model.status === 'rejected') continue;
      addGroup(faqGroups, `${model.product}:${model.slug}`, model.name, model.product, model.slug);
    }
    for (const article of articles || []) {
      const id = String(article.intercom_id);
      const override = overrides[id];
      const model = override?.model && override.model !== 'all' ? (catalog.models || []).find((item) => item.slug === override.model) : modelArticleIds.get(id);
      const product = productForArticle(article, override || model);
      const label = model?.name || (product === 'policy' ? 'Non-product policies' : 'General product policies');
      const key = `${product}:${model?.slug || 'general'}`;
      addGroup(faqGroups, key, label, product, model?.slug || 'general', titleRecord(article));
    }
    const noticeGroups = new Map();
    for (const [product, label] of [['cfd', 'General CFD notices'], ['futures', 'General Futures notices'], ['policy', 'Policies & rules']]) {
      addGroup(noticeGroups, `${product}:general`, label, product, 'general');
    }
    for (const notice of notices) {
      const product = ['cfd', 'futures'].includes(notice.product) ? notice.product : 'policy';
      const model = notice.model && notice.model !== 'all' ? notice.model : 'general';
      const label = model !== 'general' ? ((catalog.models || []).find((item) => item.slug === model)?.name || model) : (product === 'policy' ? 'Non-product policies' : 'General product policies');
      addGroup(noticeGroups, `${product}:${model}`, label, product, model, titleRecord(notice));
    }
    const shape = (groups) => [...groups.values()].map((group) => ({ ...group, count: group.articles.length, articles: group.articles.sort((a, b) => a.title.localeCompare(b.title)) }))
      .sort((a, b) => a.product.localeCompare(b.product) || a.label.localeCompare(b.label));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ generatedAt: new Date().toISOString(), faq: shape(faqGroups), notices: shape(noticeGroups), totals: { faq: (articles || []).length, notices: notices.length } });
  } catch (error) { return res.status(500).json({ error: error.message }); }
}
