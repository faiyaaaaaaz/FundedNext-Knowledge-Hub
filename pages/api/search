import {
  checkPassword,
  getPassword,
  getKeys,
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

    // 1. Turn the question into "meaning" numbers and find the closest pieces
    const [qvec] = await openaiEmbed(openaiKey, [question]);
    const { data: matches, error } = await sb.rpc('match_chunks', {
      query_embedding: qvec,
      match_threshold: 0.3,
      match_count: 8
    });
    if (error) throw new Error('Search failed: ' + error.message);

    if (!matches || !matches.length) {
      return res.status(200).json({
        answer: "I couldn't find anything about that in the knowledge base.",
        sources: []
      });
    }

    // 2. Build the context we hand to GPT
    const context = matches
      .map((m, i) => `[${i + 1}] ${m.article_title}\nURL: ${m.article_url}\n${m.content}`)
      .join('\n\n---\n\n');

    // 3. Build the authoritative source list ourselves (URLs cannot be invented)
    const seen = new Set();
    const sources = [];
    for (const m of matches) {
      if (!seen.has(m.article_id)) {
        seen.add(m.article_id);
        sources.push({ title: m.article_title, url: m.article_url });
      }
    }

    const system =
      'You are a support knowledge assistant. Answer the question using ONLY the ' +
      'knowledge-base excerpts provided. If the answer is not in them, say you ' +
      "couldn't find it in the knowledge base. Be clear and concise. Do not write " +
      'URLs yourself — the app displays the sources separately.';
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
