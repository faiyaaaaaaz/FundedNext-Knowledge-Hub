import {
  authenticateRequest,
  getKeys,
  supabaseAdmin,
  fetchAllPublishedArticles,
  htmlToText,
  chunkText,
  sha256,
  openaiEmbed
} from '../../lib/server';

export const config = { maxDuration: 60 };

const PROCESS_BATCH = 25;   // articles indexed per call (fast, no Intercom fetch)
const EMBED_BATCH = 256;
const INSERT_BATCH = 50;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function embedWithRetry(key, inputs) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await openaiEmbed(key, inputs); }
    catch (e) { lastErr = e; await sleep(1500 * (attempt + 1)); }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    const { intercomToken, openaiKey } = await getKeys();
    if (!intercomToken) return res.status(400).json({ error: 'No Intercom key saved yet. Add it in Admin first.' });
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key saved yet. Add it in Admin first.' });

    const sb = supabaseAdmin();

    // ===== PHASE 1: is there queued work? Index a batch (fast, no Intercom) =====
    const { data: todo, error: eTodo } = await sb
      .from('articles')
      .select('intercom_id,title,url,body')
      .eq('needs_index', true)
      .limit(PROCESS_BATCH);
    if (eTodo) throw new Error('Reading work queue failed: ' + eTodo.message);

    if (todo && todo.length) {
      const flat = [];
      todo.forEach((a, wi) => {
        const pieces = chunkText(htmlToText(a.body || ''));
        a._pieces = pieces;
        pieces.forEach((content, ci) => flat.push({ wi, ci, content }));
      });

      const vectors = new Array(flat.length);
      for (let i = 0; i < flat.length; i += EMBED_BATCH) {
        const vecs = await embedWithRetry(openaiKey, flat.slice(i, i + EMBED_BATCH).map((f) => f.content));
        for (let j = 0; j < vecs.length; j++) vectors[i + j] = vecs[j];
      }

      const ids = todo.map((a) => a.intercom_id);
      { const { error } = await sb.from('chunks').delete().in('article_id', ids); if (error) throw new Error('Clearing pieces failed: ' + error.message); }

      const rows = flat.map((f, fi) => ({
        article_id: todo[f.wi].intercom_id,
        article_title: todo[f.wi].title || '(untitled)',
        article_url: todo[f.wi].url || '',
        chunk_index: f.ci,
        content: f.content,
        embedding: vectors[fi]
      }));
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const { error } = await sb.from('chunks').insert(rows.slice(i, i + INSERT_BATCH));
        if (error) throw new Error('Saving pieces failed: ' + error.message);
      }

      { const { error } = await sb.from('articles').update({ needs_index: false, last_indexed_at: new Date().toISOString() }).in('intercom_id', ids); if (error) throw new Error('Marking done failed: ' + error.message); }

      const { count } = await sb.from('articles').select('*', { count: 'exact', head: true }).eq('needs_index', true);
      return res.status(200).json({
        ok: true, phase: 'indexing', processed: todo.length, remaining: count || 0,
        done: (count || 0) === 0, sampleTitles: todo.slice(0, 3).map((a) => a.title || '(untitled)')
      });
    }

    // ===== PHASE 2: nothing queued -> detect changes from Intercom (runs once) =====
    const articles = await fetchAllPublishedArticles(intercomToken);
    const liveIds = new Set(articles.map((a) => String(a.id)));

    const { data: stored, error: e1 } = await sb.from('articles').select('intercom_id, content_hash');
    if (e1) throw new Error('Reading stored failed: ' + e1.message);
    const storedMap = new Map((stored || []).map((r) => [r.intercom_id, r.content_hash]));

    const storedCount = storedMap.size;
    const fetchedCount = liveIds.size;
    const safeToDelete = fetchedCount > 0 && (storedCount === 0 || fetchedCount >= storedCount * 0.5);
    let deleted = 0;
    if (safeToDelete) {
      const toDelete = [...storedMap.keys()].filter((id) => !liveIds.has(id));
      if (toDelete.length) {
        const { error } = await sb.from('articles').delete().in('intercom_id', toDelete);
        if (error) throw new Error('Removing old failed: ' + error.message);
        deleted = toDelete.length;
      }
    }

    const flagged = [];
    for (const a of articles) {
      const id = String(a.id);
      const hash = sha256((a.title || '') + '\n' + (a.body || ''));
      if (storedMap.get(id) !== hash) {
        flagged.push({
          intercom_id: id,
          title: a.title || '(untitled)',
          url: a.url || '',
          state: 'published',
          updated_at: a.updated_at || null,
          content_hash: hash,
          body: a.body || '',
          needs_index: true
        });
      }
    }
    for (let i = 0; i < flagged.length; i += 100) {
      const { error } = await sb.from('articles').upsert(flagged.slice(i, i + 100));
      if (error) throw new Error('Queuing changes failed: ' + error.message);
    }

    return res.status(200).json({
      ok: true,
      phase: flagged.length ? 'detecting' : 'idle',
      processed: 0,
      remaining: flagged.length,
      deleted,
      totalPublished: articles.length,
      done: flagged.length === 0
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
