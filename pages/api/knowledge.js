import {
  authenticateRequest, supabaseAdmin, listKnowledge, saveKnowledgeDoc,
  deleteKnowledgeDoc, knowledgeStatus, reindexKnowledge, getKeys, saveScopeModelOverride, saveArticleScopeOverride
} from '../../lib/server';

// Admin-only. Manage internal knowledge documents and push them into the
// chatbot's searchable knowledge.
export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    const sb = supabaseAdmin();

    if (req.method === 'GET') {
      return res.status(200).json(await knowledgeStatus(sb));
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (body.action === 'reindex') {
        const { openaiKey } = await getKeys();
        const result = await reindexKnowledge(sb, { openaiKey });
        return res.status(200).json({ ok: true, ...result });
      }
      if (body.action === 'scope-status') {
        const catalog = await saveScopeModelOverride(body.slug, { status: body.status, product: body.product, name: body.name }, sb);
        return res.status(200).json({ ok: true, scopeCatalog: catalog });
      }
      if (body.action === 'article-scope') {
        const catalog = await saveArticleScopeOverride(body.articleId, { product: body.product, model: body.model }, sb);
        return res.status(200).json({ ok: true, scopeCatalog: catalog });
      }
      const doc = await saveKnowledgeDoc(body);
      return res.status(200).json({ ok: true, doc });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id || (req.body && req.body.id);
      if (!id) return res.status(400).json({ error: 'Missing document id.' });
      await deleteKnowledgeDoc(id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
