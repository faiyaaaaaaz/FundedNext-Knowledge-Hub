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

    // 1. Find the closest pieces (fewer + a slightly higher bar = tighter results)
    const [qvec] = await openaiEmbed(openaiKey, [question]);
    const { data: matches, error } = await sb.rpc('match_chunks', {
      query_embedding: qvec,
      match_threshold: 0.35,
      match_count: 5
    });
    if (error) throw new Error('Search failed: ' + error.message);

    if (!matches || !matches.length) {
      return res.status(200).json({
        answer: "I couldn't find anything about that in the knowledge base.",
        sources: []
      });
    }

    // 2. Context for the model
    const context = matches
      .map((m, i) => `[${i + 1}] ${m.article_title}\nURL: ${m.article_url}\n${m.content}`)
      .join('\n\n---\n\n');

    // 3. Authoritative source list (URLs come from our data, never invented)
    const seen = new Set();
    const sources = [];
    for (const m of matches) {
      if (!seen.has(m.article_id)) {
        seen.add(m.article_id);
        sources.push({ title: m.article_title, url: m.article_url });
      }
    }

    const system =
      'You are a support knowledge assistant for FundedNext. Answer the user\'s ' +
      'question directly and concisely using ONLY the knowledge-base excerpts provided.\n' +
      'Rules:\n' +
      '1. Answer ONLY what was asked. Do not add related details the user did not request.\n' +
      "2. If the excerpts do not contain the answer, reply only that you couldn't find it in the knowledge base.\n" +
      '3. Be brief: a few sentences, or a short list using "- " lines when the answer is genuinely a list.\n' +
      '4. You may use **bold** for key terms.\n' +
      '5. Never write URLs yourself; sources are displayed separately.';
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
