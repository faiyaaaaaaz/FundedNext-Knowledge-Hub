import { authenticateRequest, getKeys, imageStageFingerprint, readImageTextCache, saveImageTextCache, supabaseAdmin, syncStep, withSyncLease } from '../../lib/server';
import { authenticateExternalApiKey } from '../../lib/externalAccess';
import { faqImages } from '../../lib/faqImageText.mjs';

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '4mb' } } };

// Imports reviewed image readings from a file and publishes them. Readings are
// saved per image, then each article is indexed from them without any vision
// call. A request works for about 40 seconds and returns the articles still to
// do; send them back as { articleIds } until `remaining` is empty.
//
// File format: { format: 'fundednext-image-readings-v1', articles: [
//   { articleId, images: [{ key, text }] } ] }
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    let access = null;
    try { access = await authenticateRequest(req); } catch { access = null; }
    if (!access) access = await authenticateExternalApiKey(req, 'knowledge:retry-article');
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sb = supabaseAdmin();
    const started = Date.now();

    let stored = 0, ignored = 0;
    let ids = Array.isArray(body.articleIds) ? body.articleIds : [];
    if (Array.isArray(body.articles)) {
      if (body.format && body.format !== 'fundednext-image-readings-v1') return res.status(400).json({ error: 'Unsupported file format.' });
      const entries = [];
      for (const article of body.articles.slice(0, 600)) {
        if (!/^\d{1,25}$/.test(String(article?.articleId || ''))) { ignored++; continue; }
        ids.push(String(article.articleId));
        for (const image of Array.isArray(article.images) ? article.images.slice(0, 120) : []) {
          if (typeof image?.key === 'string' && /^https:\/\//.test(image.key) && typeof image.text === 'string') entries.push({ key: image.key, text: image.text });
          else ignored++;
        }
      }
      stored = await saveImageTextCache(sb, entries);
    }
    ids = [...new Set(ids.map(String).filter((id) => /^\d{1,25}$/.test(id)))].slice(0, 600);
    if (!ids.length) return res.status(400).json({ error: 'No articles to import.' });

    const keys = await getKeys();
    const results = [];
    let index = 0;
    for (; index < ids.length; index++) {
      if (Date.now() - started > 38000) break;
      const id = ids[index];
      const found = await sb.from('articles').select('intercom_id,body').eq('intercom_id', id).eq('state', 'published').maybeSingle();
      if (found.error) throw new Error(found.error.message);
      if (!found.data) { results.push({ id, status: 'not-found' }); continue; }
      const images = faqImages(found.data.body);
      if (!images.length) { results.push({ id, status: 'no-images' }); continue; }
      const cached = await readImageTextCache(sb, images);
      const texts = images.map((image) => cached[image.key] || null);
      if (!texts.some(Boolean)) { results.push({ id, status: 'no-readings', images: images.length }); continue; }
      const { error } = await sb.from('settings').upsert({ key: 'faq_image_stage_' + id, value: JSON.stringify({ fingerprint: imageStageFingerprint(found.data.body), texts }) });
      if (error) throw new Error('Could not save the readings: ' + error.message);
      const outcome = await withSyncLease(sb, 'manual', async () => syncStep(sb, keys, { articleId: id, publishSaved: true }));
      if (outcome.locked) break; // another indexing pass is running; retry this article next call
      const missing = texts.flatMap((text, i) => text ? [] : [i + 1]);
      results.push({ id, status: outcome.processed === 1 && !outcome.imageFailures ? 'indexed' : 'partial', images: images.length, missingImages: missing, passages: outcome.chunkCount ?? null });
    }
    const remaining = ids.slice(index);
    return res.status(200).json({ stored, ignored, processed: results.length, indexed: results.filter((item) => item.status === 'indexed').length, results, remaining, done: remaining.length === 0, elapsedMs: Date.now() - started });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
}
