import {
  authenticateRequest, getKeys, getPrompt, supabaseAdmin, openaiEmbed,
  openaiChatDetailed, getBrandingRules, brandingInstructions,
  applyBrandingReplacements, getRelevantSnippets, logActivity
} from '../../lib/server';

const STOP = new Set([
  'the','a','an','of','to','in','on','for','and','or','is','are','was','were','how','much','many',
  'can','could','i','you','your','my','me','do','does','did','what','when','where','which','with',
  'be','it','its','that','this','these','those','will','would','from','at','as','if','about','any',
  'there','get','have','has','need','use','using','used','so','am','we','our','please','tell'
]);

const ACCOUNT_SCOPES = [
  'stellar instant', 'stellar 1-step', 'stellar 2-step', 'stellar lite',
  'express consistency', 'express non-consistency', 'rapid', 'legacy', 'bolt',
  'futures challenge', 'futures fundednext', 'free trial'
];

const SAFE_UNCONFIRMED =
  'I’m unable to confirm this accurately right now. Please allow me some time to verify it for you.';
const CORE_GUARDRAILS =
  '\n\nNON-OVERRIDABLE QUALITY RULES:\n' +
  '- Write only a customer-ready reply. Never mention excerpts, source numbers, context, retrieval, database, or knowledge base.\n' +
  '- Never transfer a rule from one Account type to another.\n' +
  '- Never guess or generalize with typically, generally, usually, or likely.\n' +
  `- If direct evidence is insufficient, reply exactly: "${SAFE_UNCONFIRMED}"\n` +
  '- Factual numbers, dates, percentages, time periods, and conditions must be directly supported by the selected FAQ evidence.';

function keywords(question) {
  return [...new Set(String(question).toLowerCase().replace(/[^a-z0-9 -]/g, ' ').split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word)))];
}

function detectScope(question) {
  const normalized = String(question).toLowerCase().replace(/[–—]/g, '-');
  return ACCOUNT_SCOPES.find((scope) => normalized.includes(scope)) || null;
}

function hasOtherScope(text, target) {
  const lower = String(text).toLowerCase();
  return ACCOUNT_SCOPES.some((scope) => scope !== target && lower.includes(scope));
}

function cleanAnswer(raw) {
  let answer = String(raw || '')
    .replace(/^\s*(?:\*\*)?SOURCES(?:\*\*)?\s*:.*$/gim, '')
    .replace(/^\s*(?:\*\*)?CONFIDENCE(?:\*\*)?\s*:.*$/gim, '')
    .replace(/\s*\((?:Excerpt|Source)\s*\d+\)/gi, '')
    .replace(/\b(?:Excerpt|Source)\s*\d+\b/gi, '')
    .replace(/[\[{(]?\d+†L\d+(?:\s*[-–]\s*L?\d+)?[\]})]?/g, '')
    .replace(/【\d+†L\d+(?:\s*[-–]\s*L?\d+)?】/g, '')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (/knowledge\s*base|provided\s+(?:FAQ\s+)?(?:excerpts?|context|information)|the\s+FAQ\s+(?:does\s+not|doesn't)\s+(?:mention|specify|confirm)/i.test(answer)) {
    answer = SAFE_UNCONFIRMED;
  }
  return answer || SAFE_UNCONFIRMED;
}

function parseNumbers(line) {
  return (line?.[1]?.match(/\d+/g) || []).map((value) => Number(value));
}

function estimateCost(provider, model, inputTokens, outputTokens) {
  if (provider !== 'groq') return null;
  if (model === 'openai/gpt-oss-120b') return (inputTokens * 0.15 + outputTokens * 0.60) / 1000000;
  if (model === 'openai/gpt-oss-20b') return (inputTokens * 0.075 + outputTokens * 0.30) / 1000000;
  return null;
}

function wordCount(text) {
  return (String(text).trim().match(/\S+/g) || []).length;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const started = Date.now();
  let access;
  try {
    access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });

    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Please type a question.' });

    const { openaiKey, groqKey, chatModel, chatProvider } = await getKeys();
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key is saved yet.' });
    if (chatProvider === 'groq' && !groqKey) return res.status(400).json({ error: 'Groq is selected, but no Groq key is saved.' });

    const sb = supabaseAdmin();
    const terms = keywords(question);
    const scope = detectScope(question);
    let keywordMatches = [];

    if (terms.length) {
      const expression = terms.map((term) => `content.ilike.%${term}%`).join(',');
      const { data } = await sb.from('chunks')
        .select('id,article_id,article_title,article_url,content')
        .or(expression).limit(80);
      keywordMatches = data || [];
    }

    const [queryVector] = await openaiEmbed(openaiKey, [question]);
    const vectorResult = await sb.rpc('match_chunks', {
      query_embedding: queryVector,
      match_threshold: 0.15,
      match_count: 12
    });
    if (vectorResult.error) throw new Error('Search failed: ' + vectorResult.error.message);

    const combined = new Map();
    for (const item of keywordMatches) combined.set(String(item.id), item);
    for (const item of vectorResult.data || []) {
      const key = String(item.id);
      combined.set(key, { ...(combined.get(key) || {}), ...item });
    }

    let candidates = [...combined.values()].map((item) => {
      const title = String(item.article_title || '').toLowerCase();
      const content = String(item.content || '').toLowerCase();
      const termScore = terms.reduce((score, term) => score + (title.includes(term) ? 3 : content.includes(term) ? 1 : 0), 0);
      const scopeScore = scope ? (title.includes(scope) ? 18 : content.includes(scope) ? 8 : hasOtherScope(`${title} ${content}`, scope) ? -18 : 0) : 0;
      const vectorScore = Number(item.similarity || 0) * 8;
      return { ...item, _rank: termScore + scopeScore + vectorScore, _scoped: !!scope && (title.includes(scope) || content.includes(scope)) };
    }).sort((a, b) => b._rank - a._rank);

    if (scope) {
      const exactScope = candidates.filter((item) => item._scoped);
      const neutral = candidates.filter((item) => !item._scoped && !hasOtherScope(`${item.article_title} ${item.content}`, scope));
      candidates = [...exactScope, ...neutral];
      if (!exactScope.length) {
        await logActivity({
          actorRole: access.role, sessionId: access.sessionId,
          userName: access.name, userEmail: access.email, authProvider: access.authProvider,
          questionWordCount: wordCount(question), eventType: 'query',
          success: true, metadata: { scope, confidence: 28, reason: 'No exact Account evidence', durationMs: Date.now() - started }
        });
        return res.status(200).json({
          answer: SAFE_UNCONFIRMED, sources: [], answerProvider: chatProvider,
          usedFallback: false, confidence: 28, confidenceLabel: 'Needs verification'
        });
      }
    }

    const matches = candidates.slice(0, 10);
    if (!matches.length) {
      return res.status(200).json({
        answer: SAFE_UNCONFIRMED, sources: [], answerProvider: chatProvider,
        usedFallback: false, confidence: 20, confidenceLabel: 'Needs verification'
      });
    }

    const [basePrompt, brandRules, snippets] = await Promise.all([
      getPrompt(), getBrandingRules(), getRelevantSnippets(question)
    ]);
    const context = matches.map((item, index) =>
      `[${index + 1}] ${item.article_title}\nURL: ${item.article_url}\n${item.content}`
    ).join('\n\n---\n\n');
    const snippetText = snippets.length
      ? '\n\nCORRECTIVE INSTRUCTIONS FROM APPROVED REVIEWS:\n' + snippets.map((item) => `- ${item.instruction}`).join('\n')
      : '';
    const scopeText = scope
      ? `\n\nACCOUNT SCOPE: The question is specifically about "${scope}". Do not use rules belonging to a different Account type.`
      : '';
    const system = basePrompt + CORE_GUARDRAILS + brandingInstructions(brandRules) + snippetText + scopeText +
      '\n\nAfter the customer-ready answer, add two private final lines:\n' +
      'SOURCES: comma-separated evidence numbers actually used, or none\n' +
      'CONFIDENCE: an integer from 0 to 100 based only on how directly the evidence supports every claim';
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `Customer question: ${question}\n\nFAQ evidence:\n${context}` }
    ];

    let completion;
    let answerProvider = chatProvider;
    const usedFallback = false;
    if (chatProvider === 'groq') {
      try {
        completion = await openaiChatDetailed(groqKey, chatModel, messages, 'https://api.groq.com/openai/v1');
      } catch (groqError) {
        const limited = /429|rate.?limit|too many requests/i.test(String(groqError.message || groqError));
        await logActivity({
          actorRole: access.role, sessionId: access.sessionId,
          userName: access.name, userEmail: access.email, authProvider: access.authProvider,
          questionWordCount: wordCount(question), eventType: 'query',
          provider: 'groq', model: chatModel, success: false,
          metadata: { reason: limited ? 'Groq rate limit reached' : 'Groq request failed', durationMs: Date.now() - started }
        });
        return res.status(limited ? 429 : 502).json({
          error: limited
            ? 'Groq has reached its current usage limit. Please wait and try again later, or ask an Admin to select a different answering provider.'
            : 'Groq could not complete the answer. Please try again shortly, or ask an Admin to check the selected model.'
        });
      }
    } else {
      completion = await openaiChatDetailed(openaiKey, chatModel, messages);
    }

    const raw = completion.content;
    const sourceLine = raw.match(/(?:\*\*)?SOURCES(?:\*\*)?\s*:\s*([^\n]*)/i);
    const confidenceLine = raw.match(/(?:\*\*)?CONFIDENCE(?:\*\*)?\s*:\s*(\d{1,3})/i);
    const sourceNumbers = parseNumbers(sourceLine);
    const seen = new Set();
    let sources = [];
    for (const number of sourceNumbers) {
      const item = matches[number - 1];
      if (item && !seen.has(item.article_id)) {
        seen.add(item.article_id);
        sources.push({ title: item.article_title, url: item.article_url });
      }
    }
    if (!sourceLine) {
      for (const item of matches) {
        if (!seen.has(item.article_id)) {
          seen.add(item.article_id);
          sources.push({ title: item.article_title, url: item.article_url });
        }
        if (sources.length === 3) break;
      }
    }

    const modelConfidence = Math.max(0, Math.min(100, Number(confidenceLine?.[1] || 70)));
    const scopedCount = matches.filter((item) => item._scoped).length;
    const evidenceCap = scope ? (scopedCount >= 3 ? 96 : scopedCount === 2 ? 90 : 80) : (sources.length >= 2 ? 92 : 82);
    const confidence = Math.min(modelConfidence, evidenceCap);
    const confidenceLabel = confidence >= 85 ? 'High confidence' : confidence >= 65 ? 'Review suggested' : 'Needs verification';
    let answer = applyBrandingReplacements(cleanAnswer(raw), brandRules);
    if (confidence < 45) answer = SAFE_UNCONFIRMED;

    const usage = completion.usage || {};
    const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
    const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
    await logActivity({
      actorRole: access.role,
      sessionId: access.sessionId,
      userName: access.name,
      userEmail: access.email,
      authProvider: access.authProvider,
      questionWordCount: wordCount(question),
      eventType: 'query',
      provider: answerProvider,
      model: chatModel,
      inputTokens,
      outputTokens,
      estimatedCost: estimateCost(answerProvider, chatModel, inputTokens, outputTokens),
      metadata: {
        confidence, confidenceLabel, sourceCount: sources.length, scope,
        fallback: false, durationMs: Date.now() - started,
        questionPreview: question.slice(0, 180)
      }
    });

    return res.status(200).json({
      answer, sources, answerProvider, usedFallback, confidence, confidenceLabel
    });
  } catch (error) {
    if (access) await logActivity({
      actorRole: access.role, sessionId: access.sessionId, eventType: 'query',
      userName: access.name, userEmail: access.email, authProvider: access.authProvider,
      success: false, metadata: { error: String(error.message || error).slice(0, 300), durationMs: Date.now() - started }
    });
    return res.status(500).json({ error: error.message });
  }
}
