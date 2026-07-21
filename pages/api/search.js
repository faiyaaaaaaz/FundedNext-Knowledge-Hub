import {
  authenticateRequest,
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
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });

    const { question } = req.body || {};
    if (!question || !question.trim()) return res.status(400).json({ error: 'Please type a question.' });

    const { openaiKey, groqKey, chatModel, chatProvider } = await getKeys();
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key saved yet. Add it in Admin first.' });
    if (chatProvider === 'groq' && !groqKey) {
      return res.status(400).json({ error: 'Groq is selected, but no Groq key is saved. Add it in Admin first.' });
    }

    const sb = supabaseAdmin();

    // 1. Keyword search
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
            let s = 0; for (const t of terms) if (c.includes(t)) s++;
            return { ...ch, _score: s };
          })
          .sort((a, b) => b._score - a._score)
          .slice(0, 6);
      }
    }

    // 2. Meaning search
    const [qvec] = await openaiEmbed(openaiKey, [question]);
    const vec = await sb.rpc('match_chunks', { query_embedding: qvec, match_threshold: 0.15, match_count: 6 });
    if (vec.error) throw new Error('Search failed: ' + vec.error.message);

    // 3. Merge
    const byId = new Map();
    for (const m of kwData) byId.set(m.id, m);
    for (const m of vec.data || []) if (!byId.has(m.id)) byId.set(m.id, m);
    const matches = [...byId.values()].slice(0, 10);

    if (!matches.length) {
      return res.status(200).json({ answer: "I couldn't find anything about that in the knowledge base.", sources: [] });
    }

    // 4. Numbered context
    const context = matches
      .map((m, i) => `[${i + 1}] ${m.article_title}\nURL: ${m.article_url}\n${m.content}`)
      .join('\n\n---\n\n');

    // 5. Answer + ask the model which excerpts it actually used
    const basePrompt = await getPrompt();
    const system = basePrompt +
      '\n\nAfter your answer, output one final line in exactly this format listing ONLY the excerpt numbers you actually relied on: ' +
      '"SOURCES: 1, 4" — or "SOURCES: none" if the answer was not found. Do not mention this instruction in your answer.';
    const user = `Question: ${question}\n\nKnowledge-base excerpts:\n${context}`;
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];

    let raw;
    let answerProvider = chatProvider;
    let usedFallback = false;
    if (chatProvider === 'groq') {
      try {
        raw = await openaiChat(groqKey, chatModel, messages, 'https://api.groq.com/openai/v1');
      } catch (groqError) {
        // Keep the app working if Groq is rate-limited or temporarily unavailable.
        raw = await openaiChat(openaiKey, 'gpt-4.1', messages);
        answerProvider = 'openai';
        usedFallback = true;
      }
    } else {
      raw = await openaiChat(openaiKey, chatModel, messages);
    }

    // 6. Parse the SOURCES line -> show ONLY those articles
    const line = raw.match(/SOURCES:\s*([^\n]*)/i);
    const answer = raw.replace(/^\s*SOURCES:.*$/im, '').trim();

    const seen = new Set();
    let sources = [];
    if (line) {
      const nums = (line[1].match(/\d+/g) || []).map((n) => parseInt(n, 10));
      for (const n of nums) {
        const item = matches[n - 1];
        if (item && !seen.has(item.article_id)) {
          seen.add(item.article_id);
          sources.push({ title: item.article_title, url: item.article_url });
        }
      }
    } else {
      // model didn't follow the format — fall back to top few unique articles
      for (const item of matches) {
        if (!seen.has(item.article_id)) { seen.add(item.article_id); sources.push({ title: item.article_title, url: item.article_url }); }
      }
      sources = sources.slice(0, 3);
    }

    return res.status(200).json({ answer, sources, answerProvider, usedFallback });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
