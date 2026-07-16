import {
  checkPassword,
  getPassword,
  getKeys,
  getPrompt,
  supabaseAdmin,
  openaiEmbed,
  openaiChat
} from '../../lib/server';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!checkPassword(getPassword(req))) return res.status(401).json({ error: 'Wrong password.' });

    const { question } = req.body || {};
    if (!question || !question.trim()) return res.status(400).json({ error: 'Please type a question.' });

    const { openaiKey, chatModel } = await getKeys();
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key saved yet. Add it in Admin first.' });

    const sb = supabaseAdmin();

    // ---- HYBRID SEARCH: meaning-search + exact keyword-search ----
    const [qvec] = await openaiEmbed(openaiKey, [question]);
    const vec = await sb.rpc('match_chunks', {
      query_embedding: qvec,
      match_threshold: 0.15,
      match_count: 8
    });
    if (vec.error) throw new Error('Search failed: ' + vec.error.message);

    let kwData = [];
    try {
      const kw = await sb.rpc('keyword_chunks', { query_text: question, match_count: 8 });
      if (!kw.error && Array.isArray(kw.data)) kwData = kw.data;
    } catch (e) {
      // keyword search not installed yet; meaning-search still works
    }

    const byId = new Map();
    for (const m of vec.data || []) byId.set(m.id, m);
    for (const m of kwData) if (!byId.has(m.id)) byId.set(m.id, m);
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
