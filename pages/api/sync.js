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

const EMBED_BATCH = 256;
const WAVE_MAX_ARTICLES = 50;
const WAVE_MAX_CHUNKS = 300;
const INSERT_BATCH = 50;
const BUDGET_MS = 45000;

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
    if (!checkPassword(getPassword(req))) return res.status(401).json({ error: 'Wrong password.' });

    const { intercomToken, openaiKey } = await getKeys();
    if (!intercomToken) return res.status(400).json({ error: 'No Intercom key saved yet. Add it in Admin first.' });
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key saved yet. Add it in Admin first.' });

    const sb = supabaseAdmin();
    const started = Date.now();

    const articles = await fetchAllPublishedArticles(intercomToken);
    const liveIds = new Set(articles.map((a) => String(a.id)));

    const { data: stored, error: e1 } = await sb.from('articles').select('intercom_id, content_hash');
    if (e1) throw new Error('Reading stored articles failed: ' + e1.message);
    const storedMap = new Map((stored || []).map((r) => [r.intercom_id, r.content_hash]));

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

    const pending = [];
    for (const a of articles) {
      const id = String(a.id);
      const hash = sha256((a.title || '') + '\n' + (a.body || ''));
      if (storedMap.get(id) !== hash) pending.push({ id, hash, a });
    }

    let processed = 0;
    let remaining = pending.length;
    let idx = 0;

    const meta = (w, content_hash) => ({
      intercom_id: w.id,
      title: w.a.title || '(untitled)',
      url: w.a.url || '',
      state: 'published',
      updated_at: w.a.updated_at || null,
      content_hash,
      last_indexed_at: new Date().toISOString()
    });

    while (idx < pending.length) {
      if (Date.now() - started > BUDGET_MS) break;

      const wave = [];
      let pieceCount = 0;
      while (idx < pending.length && wave.length < WAVE_MAX_ARTICLES && pieceCount < WAVE_MAX_CHUNKS) {
        const item = pending[idx];
        const pieces = chunkText(htmlToText(item.a.body || ''));
        wave.push({ id: item.id, hash: item.hash, a: item.a, pieces });
        pieceCount += pieces.length;
        idx++;
        if (pieces.length >= WAVE_MAX_CHUNKS) break;
      }
      const waveIds = wave.map((w) => w.id);

      {
        const { error } = await sb.from('articles').upsert(wave.map((w) => meta(w, 'pending')));
        if (error) throw new Error('Preparing articles failed: ' + error.message);
      }

      {
        const { error } = await sb.from('chunks').delete().in('article_id', waveIds);
        if (error) throw new Error('Clearing old pieces failed: ' + error.message);
      }

      const flat = [];
      wave.forEach((w, wi) => w.pieces.forEach((content, ci) => flat.push({ wi, ci, content })));
      const vectors = new Array(flat.length);
      for (let i = 0; i < flat.length; i += EMBED_BATCH) {
        const vecs = await embedWithRetry(openaiKey, flat.slice(i, i + EMBED_BATCH).map((f) => f.content));
        for (let j = 0; j < vecs.length; j++) vectors[i + j] = vecs[j];
      }

      const chunkRows = flat.map((f, fi) => ({
        article_id: wave[f.wi].id,
        article_title: wave[f.wi].a.title || '(untitled)',
        article_url: wave[f.wi].a.url || '',
        chunk_index: f.ci,
        content: f.content,
        embedding: vectors[fi]
      }));
      for (let i = 0; i < chunkRows.length; i += INSERT_BATCH) {
        const { error } = await sb.from('chunks').insert(chunkRows.slice(i, i + INSERT_BATCH));
        if (error) throw new Error('Saving pieces failed: ' + error.message);
      }

      {
        const { error } = await sb.from('articles').upsert(wave.map((w) => meta(w, w.hash)));
        if (error) throw new Error('Finalizing articles failed: ' + error.message);
      }

      processed += wave.length;
      remaining -= wave.length;
    }

    return res.status(200).json({
      ok: true, done: remaining <= 0, processed, remaining: Math.max(0, remaining), deleted, totalPublished: articles.length
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
