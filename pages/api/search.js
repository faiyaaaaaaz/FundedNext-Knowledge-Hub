import {
  authenticateRequest, getKeys, getPrompt, supabaseAdmin, openaiEmbed,
  openaiChatDetailed, getBrandingRules, brandingInstructions,
  applyBrandingReplacements, getRelevantSnippets, logActivity,
  expandConcepts, clarifyQuery, correctTypos, tryCalculator
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
  '- Use plain text only. Do not use Markdown, bold text, italics, headings, asterisks, underscores, or decorative symbols.\n' +
  '- Keep paragraphs short and separated by one blank line. Use simple numbered steps only when a sequence is genuinely needed.\n' +
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
    // Normalize every exotic Unicode space (narrow/thin/no-break etc.) to a
    // plain space. Models often emit these around times and units ("6:00 AM",
    // "GMT+3"), which render cramped and paste badly when copied.
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u2060\u3000\uFEFF]/g, ' ')
    .replace(/^\s*(?:\*\*)?SOURCES(?:\*\*)?\s*:.*$/gim, '')
    .replace(/^\s*(?:\*\*)?CONFIDENCE(?:\*\*)?\s*:.*$/gim, '')
    .replace(/^\s*(?:\*\*)?SEGMENTS?(?:\*\*)?\s*:.*$/gim, '')
    .replace(/\s*\((?:Excerpt|Source)\s*\d+\)/gi, '')
    .replace(/\b(?:Excerpt|Source)\s*\d+\b/gi, '')
    .replace(/[\[{(]?\d+†L\d+(?:\s*[-–]\s*L?\d+)?[\]})]?/g, '')
    .replace(/【[^】]*】/g, '')
    // Remove inline bracketed citation markers like [3], [8], [3, 8], [3-5].
    .replace(/\s*\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/g, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/[*_]/g, '')
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

    const { openaiKey, groqKey, chatModel, chatProvider, smartRetrieval } = await getKeys();

    // Deterministic calculator first: if this is a real calculation the tool can
    // do exactly (margin, max lot, PnL, pips, risk sizing), compute it here and
    // return the exact figure with a Trade Calculator reference — no RAG, no
    // model arithmetic. Falls through to the FAQ pipeline for everything else.
    const calc = await tryCalculator({ question, provider: chatProvider, model: chatModel, openaiKey, groqKey });
    if (calc?.handled) {
      const label = calc.confidence >= 85 ? 'High confidence' : calc.confidence >= 65 ? 'Review suggested' : 'Needs verification';
      await logActivity({
        actorRole: access.role, sessionId: access.sessionId, userName: access.name,
        userEmail: access.email, authProvider: access.authProvider,
        questionWordCount: wordCount(question), eventType: 'query', provider: 'calculator',
        model: calc.calcType, success: true,
        metadata: { confidence: calc.confidence, calc: calc.calcType, durationMs: Date.now() - started }
      });
      return res.status(200).json({
        answer: calc.answer,
        sources: [{ title: calc.sourceTitle, url: '', kind: 'calculator' }],
        segments: calc.segments || null,
        answerProvider: chatProvider, usedFallback: false,
        confidence: calc.confidence, confidenceLabel: label, usedCalculator: true
      });
    }
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key is saved yet.' });
    if (chatProvider === 'groq' && !groqKey) return res.status(400).json({ error: 'Groq is selected, but no Groq key is saved.' });

    const sb = supabaseAdmin();
    const scope = detectScope(question);

    // ---- Query understanding -------------------------------------------------
    // 1) deterministic concept expansion grounded in FundedNext terminology
    const concepts = expandConcepts(question);
    // 2) optional LLM rewrite for messy/vague input (non-fatal, may be null)
    let clarity = null;
    if (smartRetrieval) {
      clarity = await clarifyQuery({
        question, provider: chatProvider, model: chatModel, openaiKey, groqKey
      });
    }
    const clearQuestion = (clarity?.clear && clarity.clear.length > 3) ? clarity.clear : question;

    // A question is ambiguous when the model flags it, when it touches two
    // genuinely different meaning-groups, OR when it is a *bare* payout question
    // ("when do I get paid") with no wording that pins down which aspect is meant.
    const meaningGroups = new Set(concepts.groups);
    const distinctMeanings = ['payout_timing', 'processing_speed', 'cycle', 'withdraw_method']
      .filter((g) => meaningGroups.has(g));

    const probe = (correctTypos(question) + ' ' + clearQuestion).toLowerCase();
    const hasProcessingQualifier = /(how long|how fast|how quickly|processing|processed|receive|received|arrive|arrival|transfer time|24 ?hour|24-hour|brand promise|compensat|initiat)/.test(probe);
    const hasCycleQualifier = /(cycle|how often|frequency|first payout|eligib|request a payout|when can i (?:request|withdraw)|trading days|next payout)/.test(probe);
    const hasMethodQualifier = /(method|usdt|usdc|crypto|bank|rise ?works|network|erc20|trc20|wallet|minimum|maximum|\bfee)/.test(probe);
    const payoutish = meaningGroups.has('payout_timing') || /\b(get paid|getting paid|paid|payout|withdraw)\b/.test(probe);
    // The classic ambiguous case: a payout question that names no specific aspect.
    const payoutUmbrella = payoutish && !hasProcessingQualifier && !hasCycleQualifier && !hasMethodQualifier;

    const isAmbiguous = !!clarity?.ambiguous || distinctMeanings.length >= 2 || payoutUmbrella;

    const DEFAULT_PAYOUT_INTERPRETATIONS = [
      'Payout eligibility and timing — this depends on the Account model / trading cycle',
      'How long processing takes after a payout request — the 24-hour Brand Promise',
      'How long funds take to arrive by withdrawal method'
    ];
    const interpretations = clarity?.interpretations?.length
      ? clarity.interpretations
      : (payoutUmbrella ? DEFAULT_PAYOUT_INTERPRETATIONS
        : (isAmbiguous ? distinctMeanings.map((g) => g.replace(/_/g, ' ')) : []));

    // For a bare payout question, force retrieval to cover every meaning so the
    // eligibility/cycle evidence is present, not just the dominant 24-hour one.
    const umbrellaExpansions = payoutUmbrella ? [
      'payout eligibility trading cycle by account model Stellar 1-Step 2-Step Lite',
      'when a trader becomes eligible to request the first payout profit split schedule',
      'payout processing time 24 hour Brand Promise compensation',
      'withdrawal processing time by method crypto USDT bank'
    ] : [];

    // ---- Keyword recall (typo-corrected) ------------------------------------
    const terms = keywords(correctTypos(question) + ' ' + clearQuestion);
    let keywordMatches = [];
    if (terms.length) {
      const expression = terms.map((term) => `content.ilike.%${term}%`).join(',');
      const { data } = await sb.from('chunks')
        .select('id,article_id,article_title,article_url,content')
        .or(expression).limit(80);
      keywordMatches = data || [];
    }

    // ---- Multi-vector semantic recall ---------------------------------------
    // Embed the original + clarified question + each interpretation phrase, then
    // union their vector matches so every plausible meaning contributes evidence.
    const embedTexts = [...new Set([
      question, clearQuestion,
      ...(clarity?.queries || []),
      ...umbrellaExpansions,
      ...concepts.expansions
    ].map((t) => String(t || '').trim()).filter(Boolean))].slice(0, 8);

    const vectors = await openaiEmbed(openaiKey, embedTexts);
    const combined = new Map();
    for (const item of keywordMatches) combined.set(String(item.id), item);

    const perQueryCount = embedTexts.length > 4 ? 8 : 12;
    for (const vector of vectors) {
      const vres = await sb.rpc('match_chunks', {
        query_embedding: vector, match_threshold: 0.14, match_count: perQueryCount
      });
      if (vres.error) throw new Error('Search failed: ' + vres.error.message);
      for (const item of vres.data || []) {
        const key = String(item.id);
        const prev = combined.get(key) || {};
        // keep the strongest similarity seen for this chunk across all queries
        const similarity = Math.max(Number(prev.similarity || 0), Number(item.similarity || 0));
        combined.set(key, { ...prev, ...item, similarity });
      }
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

    // When the question is ambiguous, make sure the evidence sent to the model
    // covers each meaning instead of being dominated by the single strongest
    // topic. Reserve slots for eligibility/cycle, processing, and method chunks.
    let matches;
    if (isAmbiguous && candidates.length) {
      const CYCLE_KW = ['cycle', 'first payout', 'eligible', 'eligibility', 'trading days', 'every 14', 'every 5', '14 days', '5 days', 'biweekly', 'bi-weekly', 'profit split', 'how often', 'minimum trading'];
      const PROCESS_KW = ['24 hour', '24-hour', 'brand promise', 'processed', 'processing', 'compensation', 'initiated', 'within 24'];
      const METHOD_KW = ['usdt', 'usdc', 'crypto', 'bank', 'riseworks', 'rise works', 'erc20', 'trc20', 'wallet'];
      const blob = (it) => `${it.article_title || ''} ${it.content || ''}`.toLowerCase();
      const seen = new Set();
      const picked = [];
      const take = (kw, n) => {
        let c = 0;
        for (const it of candidates) {
          if (c >= n) break;
          if (seen.has(it.id)) continue;
          const t = blob(it);
          if (kw.some((k) => t.includes(k))) { picked.push(it); seen.add(it.id); c++; }
        }
      };
      take(CYCLE_KW, 4);
      take(PROCESS_KW, 4);
      take(METHOD_KW, 2);
      for (const it of candidates) { if (picked.length >= 12) break; if (!seen.has(it.id)) { picked.push(it); seen.add(it.id); } }
      // Present the reserved evidence in overall rank order for a clean prompt.
      const order = new Map(candidates.map((it, i) => [it.id, i]));
      matches = picked.sort((a, b) => order.get(a.id) - order.get(b.id)).slice(0, 12);
    } else {
      matches = candidates.slice(0, 10);
    }
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
    // When a question could reasonably mean more than one thing, tell the model
    // to resolve each supported meaning separately instead of guessing one.
    const ambiguityText = isAmbiguous
      ? '\n\nThis question is general and can reasonably mean more than one thing. Address EACH meaning the FAQ evidence supports, each on its own short labelled line' +
        (interpretations.length ? `. The likely meanings are:\n${interpretations.map((s) => `- ${s}`).join('\n')}` : '.') +
        '\nRules for this: (a) Payout ELIGIBILITY / cycle timing depends on the Account model. If the customer did not name an Account, give the timing for each Account model the evidence supports, or clearly say it depends on the Account model and name which models differ — then, if helpful, ask which Account they have. (b) Keep the eligibility cycle and the 24-hour processing Brand Promise as separate points; never merge them into one number. (c) Only include a meaning the evidence actually supports. Use plain text labels like "Eligibility (depends on your account): ..." — no markdown symbols.'
      : '';
    // Long, multi-part questions (like the payout + risk + rules bundles agents
    // paste in) should be answered part-by-part, not refused as a whole.
    const questionMarks = (question.match(/\?/g) || []).length;
    const listedParts = (question.match(/(?:^|\n)\s*(?:\d+[.)]|[-*])\s/g) || []).length;
    const multiPart = questionMarks >= 2 || listedParts >= 2;
    const multiPartText = multiPart
      ? '\n\nThis question has several parts. Answer every part the evidence supports, each as its own clearly separated point. For any single part you cannot verify from the evidence, say only that that specific part needs checking — do not refuse or defer the entire answer because one part is unverified.'
      : '';
    // If the question is about a calculation (max lot, margin, pip value, lot
    // size, risk), push the model to use the calculator formulas that are in the
    // evidence and to ask for any missing number rather than assuming it.
    const calcText = concepts.groups.includes('calculator')
      ? '\n\nThis is a calculation question. If the FAQ evidence includes a Trade Calculator formula, use it: state the formula, then plug in the numbers. If a required value is missing (for example the current price, or the account/instrument leverage), give the formula and ask for that value instead of assuming it. Do not merge a calculation with a separate account limit — present them as distinct points.'
      : '';
    const system = basePrompt + CORE_GUARDRAILS + brandingInstructions(brandRules) + snippetText + scopeText + ambiguityText + multiPartText + calcText +
      '\n\nAfter the customer-ready answer, add three private final lines:\n' +
      'SOURCES: comma-separated evidence numbers actually used, or none\n' +
      'CONFIDENCE: an integer from 0 to 100 based only on how directly the evidence supports every claim\n' +
      'SEGMENTS: for each paragraph of your answer, in the same order and separated by semicolons, list the evidence numbers that support that paragraph. Example for three paragraphs: 2 ; 1,2 ; 1. Write a dash for a paragraph that has no supporting evidence.';
    const askedText = clearQuestion && clearQuestion !== question
      ? `Customer question: ${question}\n(Interpreted as: ${clearQuestion})`
      : `Customer question: ${question}`;
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `${askedText}\n\nFAQ evidence:\n${context}` }
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
        sources.push({ title: item.article_title, url: item.article_url, _aid: item.article_id });
      }
    }
    if (!sourceLine) {
      for (const item of matches) {
        if (!seen.has(item.article_id)) {
          seen.add(item.article_id);
          sources.push({ title: item.article_title, url: item.article_url, _aid: item.article_id });
        }
        if (sources.length === 3) break;
      }
    }

    // Returns the 1-based position of an evidence item within `sources`, adding
    // it to the list if a paragraph cites a source not already listed. This keeps
    // the per-paragraph chip numbers aligned with the verified-sources list.
    const refFor = (item) => {
      if (!item) return null;
      const existing = sources.findIndex((s) => s._aid === item.article_id);
      if (existing >= 0) return existing + 1;
      sources.push({ title: item.article_title, url: item.article_url, _aid: item.article_id });
      return sources.length;
    };

    const modelConfidence = Math.max(0, Math.min(100, Number(confidenceLine?.[1] || 70)));
    const scopedCount = matches.filter((item) => item._scoped).length;
    const evidenceCap = scope ? (scopedCount >= 3 ? 96 : scopedCount === 2 ? 90 : 80) : (sources.length >= 2 ? 92 : 82);
    const confidence = Math.min(modelConfidence, evidenceCap);
    const confidenceLabel = confidence >= 85 ? 'High confidence' : confidence >= 65 ? 'Review suggested' : 'Needs verification';
    let answer = cleanAnswer(applyBrandingReplacements(cleanAnswer(raw), brandRules));
    if (confidence < 45) answer = SAFE_UNCONFIRMED;

    // Per-paragraph attribution: map each answer paragraph to the source(s) that
    // support it, so the UI can show which FAQ backs which part. Fully optional —
    // if the model's mapping doesn't line up with the paragraphs, we skip it.
    let segments = null;
    const segLine = raw.match(/(?:\*\*)?SEGMENTS?(?:\*\*)?\s*:\s*([^\n]*)/i);
    if (segLine && answer !== SAFE_UNCONFIRMED) {
      const paras = answer.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
      const groups = segLine[1].split(';').map((g) => (g.match(/\d+/g) || []).map(Number));
      if (paras.length >= 1 && groups.length === paras.length) {
        segments = paras.map((text, i) => {
          const refs = [];
          const usedRef = new Set();
          for (const n of groups[i]) {
            const idx = refFor(matches[n - 1]);
            if (idx && !usedRef.has(idx)) { usedRef.add(idx); refs.push(idx); }
          }
          return { text, refs };
        });
        // Only worth sending if at least one paragraph actually has a citation.
        if (!segments.some((s) => s.refs.length)) segments = null;
      }
    }
    sources = sources.map(({ _aid, ...rest }) => ({ ...rest, kind: /^kb:/.test(_aid || '') ? 'calculator' : 'faq' }));
    const usedCalculator = sources.some((s) => s.kind === 'calculator');

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
        smart: !!clarity, ambiguous: isAmbiguous,
        questionPreview: question.slice(0, 180)
      }
    });

    return res.status(200).json({
      answer, sources, segments, answerProvider, usedFallback, confidence, confidenceLabel,
      ambiguous: isAmbiguous, interpretations, usedCalculator
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
