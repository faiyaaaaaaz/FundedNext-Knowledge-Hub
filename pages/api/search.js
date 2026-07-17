import {
  checkPassword,
  getPassword,
  getKeys,
  getPrompt,
  supabaseAdmin,
  openaiEmbed,
  openaiChat
} from '../../lib/server';

const STOP = new Set([
  'the','a','an','of','to','in','on','for','and','or','is','are','was','were','how','much','many',
  'can','could','i','you','your','my','me','do','does','did','what','when','where','which','with',
  'be','it','its','that','this','these','those','will','would','from','at','as','if','about','any',
  'there','get','have','has','need','use','using','used','so','am','we','our'
]);

function keywords(q) {
  return [...new Set(
    String(q).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  )];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!checkPassword(getPassword(req))) return res.status(401).json({ error: 'Wrong password.' });

    const { question } = req.body || {};
    if (!question || !question.trim()) return res.status(400).json({ error: 'Please type a question.' });

    const { openaiKey, chatModel } = await getKeys();
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key saved yet. Add it in Admin first.' });

    const sb = supabaseAdmin();

    // ---- 1. KEYWORD SEARCH (exact terms) — done in-app, no SQL setup needed ----
    const terms = keywords(question);
    let kwData = [];
    if (terms.length) {
      const orExpr = terms.map((t) => `content.ilike.%${t}%`).join(',');
      const { data, error } = await sb
        .from('chunks')
        .select('id,article_id,article_title,article_url,content')
        .or(orExpr)
        .limit(60);
      if (!error && Array.isArray(data)) {
        kwData = data
          .map((ch) => {
            const c = ch.content.toLowerCase();
            let s = 0;
            for (const t of terms) if (c.includes(t)) s++;
            return { ...ch, _score: s };
          })
          .sort((a, b) => b._score - a._score)
          .slice(0, 6);
      }
    }

    // ---- 2. MEANING SEARCH (semantic) ----
    const [qvec] = await openaiEmbed(openaiKey, [question]);
    const vec = await sb.rpc('match_chunks', {
      query_embedding: qvec,
      match_threshold: 0.15,
      match_count: 6
    });
    if (vec.error) throw new Error('Search failed: ' + vec.error.message);

    // ---- 3. Merge: exact-term matches first, then semantic; dedupe; cap ----
    const byId = new Map();
    for (const m of kwData) byId.set(m.id, m);
    for (const m of vec.data || []) if (!byId.has(m.id)) byId.set(m.id, m);
    const matches = [...byId.values()].slice(0, 10);

    if (!matches.length) {
      return res.status(200).json({
        answer: "I couldn't find anything about that in the knowledge base.",
        sources: []
      });
    }

    const context = matches
      .map((m, i) => `[${i + 1}] ${m.article_title}\nURL: ${m.article_url}\n${m.content}`)
      .join('\n\n---\n\n');

    const seen = new Set();
    const sources = [];
    for (const m of matches) {
      if (!seen.has(m.article_id)) {
        seen.add(m.article_id);
        sources.push({ title: m.article_title, url: m.article_url });
      }
    }

    const system = await getPrompt();
    const user = `Question: ${question}\n\nKnowledge-base excerpts:\n${context}`;
    const answer = await openaiChat(openaiKey, chatModel, [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);

    return res.status(200).json({ answer, sources });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
