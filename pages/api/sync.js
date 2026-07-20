import {
  checkPassword,
  getPassword,
  getKeys,
  supabaseAdmin,
  fetchAllPublishedArticles,
  htmlToText,
  chunkText,
  sha256,
  openaiEmbed
} from '../../lib/server';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!checkPassword(getPassword(req))) return res.status(401).json({ error: 'Wrong password.' });

    const { intercomToken, openaiKey } = await getKeys();
    if (!intercomToken) return res.status(400).json({ error: 'No Intercom key saved yet. Add it in Admin first.' });
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key saved yet. Add it in Admin first.' });

    const sb = supabaseAdmin();
    const started = Date.now();
    const budgetMs = 50000;

    // 1. Get every published article from Intercom (all pages)
    const articles = await fetchAllPublishedArticles(intercomToken);
    const liveIds = new Set(articles.map((a) => String(a.id)));

    // 2. What do we already have stored?
    const { data: stored, error: e1 } = await sb.from('articles').select('intercom_id, content_hash');
    if (e1) throw new Error('Reading stored articles failed: ' + e1.message);
    const storedMap = new Map((stored || []).map((r) => [r.intercom_id, r.content_hash]));

    // 3. SAFETY GUARD: only remove "gone" articles if this fetch looks complete.
    //    If the fetch returned nothing, or far fewer than we already have, we
    //    assume it was incomplete and skip deletion — so a bad fetch can never
    //    wipe the knowledge base.
    const storedCount = storedMap.size;
    const fetchedCount = liveIds.size;
    const safeToDelete = fetchedCount > 0 && (storedCount === 0 || fetchedCount >= storedCount * 0.5);
    let deleted = 0;
    if (safeToDelete) {
      const toDelete = [...storedMap.keys()].filter((id) => !liveIds.has(id));
      if (toDelete.length) {
        const { error } = await sb.from('articles').delete().in('intercom_id', toDelete);
        if (error) throw new Error('Removing old articles failed: ' + error.message);
        deleted = toDelete.length;
      }
    }

    // 4. Find articles that are new or changed
    const pending = [];
    for (const a of articles) {
      const id = String(a.id);
      const hash = sha256((a.title || '') + '\n' + (a.body || ''));
      if (storedMap.get(id) !== hash) pending.push({ a, id, hash });
    }

    // 5. Process changed ones until the time budget runs out
    let processed = 0;
    let remaining = pending.length;
    for (const { a, id, hash } of pending) {
      if (Date.now() - started > budgetMs) break;

      const title = a.title || '(untitled)';
      const url = a.url || '';
      const pieces = chunkText(htmlToText(a.body || ''));

      const { error: eUp } = await sb.from('articles').upsert({
        intercom_id: id,
        title,
        url,
        state: 'published',
        updated_at: a.updated_at || null,
        content_hash: 'pending',
        last_indexed_at: new Date().toISOString()
      });
      if (eUp) throw new Error('Preparing article failed: ' + eUp.message);

      const { error: eC } = await sb.from('chunks').delete().eq('article_id', id);
      if (eC) throw new Error('Clearing old pieces failed: ' + eC.message);

      if (pieces.length) {
        let embeddings = [];
        for (let i = 0; i < pieces.length; i += 96) {
          const vecs = await openaiEmbed(openaiKey, pieces.slice(i, i + 96));
          embeddings = embeddings.concat(vecs);
        }
        const rows = pieces.map((content, idx) => ({
          article_id: id,
          article_title: title,
          article_url: url,
          chunk_index: idx,
          content,
          embedding: embeddings[idx]
        }));
        for (let i = 0; i < rows.length; i += 100) {
          const { error: eI } = await sb.from('chunks').insert(rows.slice(i, i + 100));
          if (eI) throw new Error('Saving pieces failed: ' + eI.message);
        }
      }

      const { error: eF } = await sb
        .from('articles')
        .update({ content_hash: hash, last_indexed_at: new Date().toISOString() })
        .eq('intercom_id', id);
      if (eF) throw new Error('Finalizing article failed: ' + eF.message);

      processed++;
      remaining--;
    }

    return res.status(200).json({
      ok: true,
      done: remaining === 0,
      processed,
      remaining,
      deleted,
      totalPublished: articles.length
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
