import {
  authenticateRequest, getKeys, getPrompt, supabaseAdmin, openaiEmbed,
  openaiChatDetailed, getBrandingRules, brandingInstructions,
  applyBrandingReplacements, getRelevantSnippets, logActivity,
  expandConcepts, clarifyQuery, correctTypos, runCalculators,
  getGroqKeys, verifyGrounding, getPublishedScopeCatalog, modelsMentioned, getArticleScopeOverrides
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
    // Convert/strip LaTeX math markup that some models emit (\frac, \text, \[ \]).
    // Resolve inner commands (\text, \times…) first so \frac's braces are simple.
    .replace(/\\(?:text|mathrm|mathbf|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\times/g, '×').replace(/\\cdot/g, '×').replace(/\\div/g, '÷')
    .replace(/\\approx/g, '≈').replace(/\\leq?\b/g, '≤').replace(/\\geq?\b/g, '≥').replace(/\\pm/g, '±')
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1) ÷ ($2)')
    .replace(/\\left|\\right/g, '').replace(/\\[,;!]/g, ' ').replace(/\\(?:quad|qquad)/g, '  ')
    .replace(/\\\[|\\\]|\\\(|\\\)/g, ' ').replace(/\\\\/g, ' ')
    .replace(/\\[a-zA-Z]+/g, '').replace(/[{}]/g, '')
    .replace(/^\s*(?:\*\*)?SOURCES(?:\*\*)?\s*:.*$/gim, '')
    .replace(/^\s*(?:\*\*)?CONFIDENCE(?:\*\*)?\s*:.*$/gim, '')
    .replace(/^\s*(?:\*\*)?SEGMENTS?(?:\*\*)?\s*:.*$/gim, '')
    .replace(/\s*\((?:Excerpt|Source)\s*\d+\)/gi, '')
    .replace(/\b(?:Excerpt|Source)\s*\d+\b/gi, '')
    .replace(/[\[{(]?\d+†L\d+(?:\s*[-–]\s*L?\d+)?[\]})]?/g, '')
    .replace(/【[^】]*】/g, '')
    // Convert a "*" used as multiplication into × BEFORE emphasis handling, so
    // "2,000 * 0.02" isn't mistaken for italics and eaten. Only asterisks flanked
    // by spaces or sitting between digits qualify — markdown emphasis (*word*,
    // **bold**) and line-start bullets ("* item") are never space-flanked, so
    // they are left untouched.
    .replace(/(\d)\s*\*\s*(?=\d)/g, '$1 × ')
    .replace(/[ \t]\*[ \t]/g, ' × ')
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
  let usedGroqKeyLabel = null;
  try {
    access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });

    const question = String(req.body?.question || '').trim().slice(0, 20000);
    if (!question) return res.status(400).json({ error: 'Please type a question.' });

    const { openaiKey, groqKey, chatModel, chatProvider, smartRetrieval, normalUserGptFallback, adminAutoFallback, fallbackProvider, fallbackModel } = await getKeys();

    // Groq key pool for rotation; a single primary key powers the small helper
    // calls (query clarify, calculator extraction, grounding check).
    const groqPool = await getGroqKeys();
    const groqPrimary = groqKey || (groqPool[0] && groqPool[0].key) || null;
    // Groq→GPT automatic fallback is allowed ONLY for the master admin / creator.
    const canFallback = access.role === 'admin' ? adminAutoFallback : normalUserGptFallback;

    // Run the deterministic calculator over the (possibly mixed) message.
    // - Pure calculation(s) with no other question → answer exactly, here.
    // - Mixed (calc + policy) → keep the exact results and merge them into the
    //   FAQ answer below as authoritative evidence, so every part is answered.
    const calc = await runCalculators({ question, provider: chatProvider, model: chatModel, openaiKey, groqKey: groqPrimary });
    const calcResults = calc?.results || [];
    const okCalc = calcResults.filter((r) => r.ok);

    if (calc && calc.pureCalc && calcResults.length) {
      const sources = calcResults.map((r) => ({ title: r.title, url: '', kind: 'calculator' }));
      const segments = [];
      calcResults.forEach((r, i) => {
        r.text.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean).forEach((t) => segments.push({ text: t, refs: [i + 1] }));
      });
      const answer = calcResults.map((r) => r.text).join('\n\n');
      const confidence = okCalc.length === calcResults.length ? 96 : 70;
      const label = confidence >= 85 ? 'High confidence' : confidence >= 65 ? 'Review suggested' : 'Needs verification';
      await logActivity({
        actorRole: access.role, sessionId: access.sessionId, userName: access.name,
        userEmail: access.email, authProvider: access.authProvider,
        questionWordCount: wordCount(question), eventType: 'query', provider: 'calculator',
        model: calcResults.map((r) => r.calcType).join('+'), success: true,
        metadata: { confidence, calc: calcResults.map((r) => r.calcType).join('+'), durationMs: Date.now() - started }
      });
      return res.status(200).json({
        answer, sources, segments, answerProvider: chatProvider, usedFallback: false,
        confidence, confidenceLabel: label, usedCalculator: true
      });
    }
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key is saved yet.' });
    if (chatProvider === 'groq' && !groqPool.length && !groqPrimary) return res.status(400).json({ error: 'Groq is selected, but no Groq key is saved. Add one in Admin → Groq keys.' });

    const sb = supabaseAdmin();
    const scopeCatalog = await getPublishedScopeCatalog(sb);
    const articleScopeOverrides = await getArticleScopeOverrides(sb);
    const selectedProduct = ['cfd', 'futures', 'both'].includes(req.body?.scope?.product) ? req.body.scope.product : 'cfd';
    const selectedModelSlug = String(req.body?.scope?.model || 'all');
    const selectedModel = selectedModelSlug === 'all' ? null : scopeCatalog.models.find((item) =>
      item.slug === selectedModelSlug && item.status !== 'review' && (selectedProduct === 'both' || item.product === selectedProduct)
    );
    if (selectedModelSlug !== 'all' && !selectedModel) {
      return res.status(200).json({
        scopeNotice: true,
        noticeTitle: 'The selected Account model is not available',
        notice: 'Choose another verified model or search the full product family. The assistant did not broaden the search automatically.'
      });
    }
    const questionModels = modelsMentioned(question, scopeCatalog.models);
    const conflictingModel = selectedModel && questionModels.find((item) => item.slug !== selectedModel.slug);
    if (conflictingModel) {
      return res.status(200).json({
        scopeNotice: true,
        noticeTitle: 'Your question and selected scope do not match',
        notice: `The selector is set to ${selectedModel.name}, but the question mentions ${conflictingModel.name}. Change the selector if you want an answer about ${conflictingModel.name}.`
      });
    }
    const scope = selectedModel ? selectedModel.aliases[0] : detectScope(question);
    const allocationQuestion = /\b(?:maximum|max|total|aggregate)?\s*allocation\b/i.test(question);
    const personalAllocation = allocationQuestion && /\b(?:my|i|me|mine|for me)\b/i.test(question);
    if (personalAllocation && !selectedModel) {
      return res.status(200).json({
        scopeNotice: true,
        noticeTitle: 'Select the customer’s Account model first',
        notice: 'The maximum allocation differs by Account model. Choose the applicable model above, then ask the question again; the assistant may also confirm the customer’s country because regional allocation limits can apply.'
      });
    }
    const directScopedQuestion = !!scope &&
      /\b(?:can|could|do|does|did|will|would|if|what happens|how much|is there|are there)\b/i.test(question) &&
      /\b(?:reset|restart|breach|daily loss|maximum loss|mll|drawdown|fee|price|target|cycle|reward|payout|withdraw)\b/i.test(question);

    if (personalAllocation && selectedModel && selectedModel.product === 'cfd' && selectedModel.slug !== 'stellar-instant' && !req.body?.clarification) {
      return res.status(200).json({
        needsClarification: true,
        originalQuestion: question,
        clarifyingQuestion: 'Which country is the customer registered in?',
        clarificationReason: 'The country is needed because FundedNext’s maximum CFD allocation can be lower in specific regions, and U.S. Match-Trader conditions can differ.',
        choices: [
          { value: 'Standard allocation country', label: 'Another country', description: 'The customer is not in a specially restricted country and is not using the U.S. exception.' },
          { value: 'Restricted allocation country: Cambodia, Mongolia, Slovakia, Slovenia, Taiwan, Ukraine, Czech Republic, or Pakistan', label: 'Listed restricted country', description: 'The customer is registered in one of the countries listed here.' },
          { value: 'United States using Match-Trader', label: 'United States', description: 'Use the verified U.S. Match-Trader conditions.' }
        ]
      });
    }

    // ---- Query understanding -------------------------------------------------
    // 1) deterministic concept expansion grounded in FundedNext terminology
    const concepts = expandConcepts(question);
    // 2) optional LLM rewrite for messy/vague input (non-fatal, may be null)
    let clarity = null;
    if (smartRetrieval) {
      clarity = await clarifyQuery({
        question, provider: chatProvider, model: chatModel, openaiKey, groqKey: groqPrimary
      });
    }
    const clearQuestion = (clarity?.clear && clarity.clear.length > 3) ? clarity.clear : question;
    const clarificationQuestionMarks = (question.match(/\?/g) || []).length;
    const explicitMultiPart = (clarity?.topics?.length || 0) > 1 || clarificationQuestionMarks > 1 ||
      /\b(?:also|and (?:can|could|do|does|how|what|when|where|why|is|are|will|would)|second(?:ly)?|another question)\b/i.test(question);
    const answerLikeChoice = (choice) => {
      const text = `${choice?.label || ''} ${choice?.description || ''} ${choice?.value || ''}`;
      return /(?:\$|\b\d+(?:\.\d+)?%|\byou (?:can|cannot|can't|must|will|are allowed)|\bwill be|\bthe (?:limit|answer|rule) is)/i.test(text);
    };
    const safeClarificationChoices = (clarity?.choices || []).filter((choice) =>
      choice && choice.value && choice.label && !answerLikeChoice(choice)
    );

    // Stop before retrieval when a missing detail would materially change the
    // answer. The client presents these choices in a focused dialog and sends
    // the selected detail back together with the untouched original question.
    if (clarity?.needsClarification && !directScopedQuestion && !explicitMultiPart && clarity.clarifyingQuestion && safeClarificationChoices.length >= 2 && !req.body?.clarification) {
      await logActivity({
        actorRole: access.role, sessionId: access.sessionId, userName: access.name,
        userEmail: access.email, authProvider: access.authProvider,
        questionWordCount: wordCount(question), eventType: 'clarification', provider: 'openai',
        model: 'gpt-4o-mini', success: true,
        metadata: { choiceCount: safeClarificationChoices.length, durationMs: Date.now() - started }
      });
      return res.status(200).json({
        needsClarification: true,
        originalQuestion: question,
        clarifyingQuestion: clarity.clarifyingQuestion,
        clarificationReason: clarity.clarificationReason || 'This detail determines which Account rule applies.',
        choices: safeClarificationChoices
      });
    }

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
    // Do not infer payout intent from the broad word "pay" or from words such
    // as payment/payments. Those commonly refer to reset or registration fees.
    const payoutish = /\b(?:get paid|getting paid|payouts?|performance rewards?|reward share|profit split|withdraw|withdrawal|cash ?out)\b/.test(probe);
    // The classic ambiguous case: a payout question that names no specific aspect.
    const payoutUmbrella = payoutish && !hasProcessingQualifier && !hasCycleQualifier && !hasMethodQualifier;
    if (payoutUmbrella && !explicitMultiPart && !req.body?.clarification) {
      return res.status(200).json({
        needsClarification: true,
        originalQuestion: question,
        clarifyingQuestion: 'What part of the Performance Reward would you like me to explain?',
        clarificationReason: 'Eligibility, request processing, and funds arrival follow different FAQ rules and timelines.',
        choices: [
          { value: 'Eligibility timing', label: 'When I become eligible', description: 'Check when the Account can request a Performance Reward.' },
          { value: 'Request processing time', label: 'After I submit a request', description: 'Check FundedNext’s request-processing stage.' },
          { value: 'Funds arrival time', label: 'After the request is processed', description: 'Check arrival time for the selected payout method.' },
          { value: 'Full overview', label: 'Explain the full timeline', description: 'Compare eligibility, request processing, and funds arrival.' }
        ]
      });
    }

    // The visible product/model controls now provide this missing scope. Do not
    // open a redundant Account-model clarification dialog.
    const accountDependent = false;
    const asksAcrossModels = /\b(all|each|every|compare|comparison|different models?|by model)\b/i.test(question);
    if (accountDependent && !asksAcrossModels && !explicitMultiPart && !req.body?.clarification) {
      return res.status(200).json({
        needsClarification: true,
        originalQuestion: question,
        clarifyingQuestion: 'Which Account model should I check?',
        clarificationReason: 'Targets, limits, cycles, and breach rules can differ by Account model.',
        choices: [
          { value: 'Evaluation FundedNext Account', label: 'Evaluation FundedNext Account', description: 'Use the Evaluation Account rules.' },
          { value: 'Stellar 1-Step FundedNext Account', label: 'Stellar 1-Step', description: 'Use the Stellar 1-Step rules.' },
          { value: 'Stellar 2-Step FundedNext Account', label: 'Stellar 2-Step', description: 'Use the Stellar 2-Step rules.' },
          { value: 'Stellar Lite FundedNext Account', label: 'Stellar Lite', description: 'Use the Stellar Lite rules.' },
          { value: 'Stellar Instant FundedNext Account', label: 'Stellar Instant', description: 'Use the Stellar Instant rules.' },
          { value: 'Rapid Challenge', label: 'Rapid Challenge', description: 'Use the Rapid Challenge rules.' },
          { value: 'No DLL 1-Step CFD — Model FNL:001', label: 'No DLL 1-Step CFD — FNL:001', description: 'Use the FNL:001 model rules.' },
          { value: 'Compare every Account model', label: 'Compare all models', description: 'Show the differences across Account models.' }
        ]
      });
    }

    const topicPlan = clarity?.topics?.length ? clarity.topics : [{ question: clearQuestion, queries: clarity?.queries || [] }];
    const isAmbiguous = !!clarity?.ambiguous || distinctMeanings.length >= 2 || payoutUmbrella || topicPlan.length > 1;

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
    ] : allocationQuestion && !selectedModel ? [
      'maximum aggregate allocation across Stellar 1-Step Stellar 2-Step and Stellar Lite FundedNext Accounts',
      'maximum allocation Stellar Instant purchase allocation and scaling',
      'country restricted maximum allocation Cambodia Mongolia Slovakia Slovenia Taiwan Ukraine Czech Republic Pakistan',
      'Challenge Account purchase allocation compared with FundedNext Account allocation',
      'United States Match-Trader allocation restriction exception'
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
      ...topicPlan.flatMap((topic) => [topic.question, ...(topic.queries || [])]),
      ...umbrellaExpansions,
      ...concepts.expansions
    ].map((t) => String(t || '').trim()).filter(Boolean))].slice(0, 20);

    const vectors = await openaiEmbed(openaiKey, embedTexts);
    const combined = new Map();
    const vectorMatches = [];
    for (const item of keywordMatches) combined.set(String(item.id), item);

    const perQueryCount = embedTexts.length > 10 ? 6 : embedTexts.length > 4 ? 8 : 12;
    for (const vector of vectors) {
      const vres = await sb.rpc('match_chunks', {
        query_embedding: vector, match_threshold: 0.14, match_count: perQueryCount
      });
      if (vres.error) throw new Error('Search failed: ' + vres.error.message);
      vectorMatches.push(vres.data || []);
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

    // Enforce the UI selection before evidence reaches the answering model.
    // Articles naming no model are treated as product-wide policy (KYC,
    // restricted strategies, merging, scale-up, etc.). An article that names
    // only another model is rejected. Multi-model comparison articles remain
    // eligible only when they include the selected model.
    candidates = candidates.filter((item) => {
      const blob = `${item.article_title || ''}\n${item.content || ''}`;
      const override = articleScopeOverrides[String(item.article_id || '')];
      const mentioned = override?.model && override.model !== 'all'
        ? scopeCatalog.models.filter((model) => model.slug === override.model && model.product === override.product)
        : modelsMentioned(blob, scopeCatalog.models);
      const futuresEvidence = override ? override.product === 'futures' : (/\bfutures?\b/i.test(blob) || mentioned.some((model) => model.product === 'futures'));
      const cfdEvidence = override ? override.product === 'cfd' : (/\bcfd\b/i.test(blob) || mentioned.some((model) => model.product === 'cfd'));
      if (selectedProduct === 'cfd' && futuresEvidence && !cfdEvidence) return false;
      if (selectedProduct === 'futures' && !futuresEvidence) return false;
      if (!selectedModel) return true;
      if (override) return override.model === 'all' || override.model === selectedModel.slug;
      const namedInFamily = mentioned.filter((model) => model.product === selectedModel.product);
      if (!namedInFamily.length) return selectedModel.product === 'futures' ? futuresEvidence : !futuresEvidence;
      return namedInFamily.some((model) => model.slug === selectedModel.slug);
    });

    if (!candidates.length) {
      const family = selectedProduct === 'both' ? 'the complete knowledge base' : selectedProduct.toUpperCase();
      const target = selectedModel?.name || `all ${family} models`;
      return res.status(200).json({
        scopeNotice: true,
        noticeTitle: `No verified answer found for ${target}`,
        notice: selectedModel
          ? `No FAQ evidence within ${selectedModel.name} supports this question. You can search all ${selectedModel.product.toUpperCase()} models, but the assistant will not widen the scope without your approval.`
          : `No applicable evidence was found within ${family}. The assistant did not use another product's rules.`
      });
    }

    if (scope && !selectedModel) {
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
    if (allocationQuestion && !selectedModel && candidates.length) {
      const groups = [
        /how many accounts|aggregate simulated capital|\$300,?000|allocation threshold/i,
        /stellar instant|maximum purchase allocation|\$20,?000/i,
        /cambodia|mongolia|slovakia|slovenia|taiwan|ukraine|czech|pakistan|\$50,?000/i,
        /challenge accounts?|challenge phase|not applicable for purchasing/i,
        /u\.s\.|united states|match-trader|no restrictions regarding the account balance/i
      ];
      const seen = new Set(); const picked = [];
      for (const pattern of groups) {
        for (const item of candidates) {
          if (pattern.test(`${item.article_title || ''}\n${item.content || ''}`) && !seen.has(String(item.id))) {
            seen.add(String(item.id)); picked.push(item); break;
          }
        }
      }
      for (const item of candidates) {
        if (picked.length >= 14) break;
        if (!seen.has(String(item.id))) { seen.add(String(item.id)); picked.push(item); }
      }
      matches = picked;
    } else if (topicPlan.length > 1 && candidates.length) {
      // Reserve evidence for every decomposed topic before filling the remaining
      // slots by global rank. This prevents a dominant first topic from crowding
      // later questions out of a long pasted message.
      const candidateById = new Map(candidates.map((item) => [String(item.id), item]));
      const seen = new Set();
      const picked = [];
      for (const topic of topicPlan) {
        const topicTexts = [topic.question, ...(topic.queries || [])].map((t) => String(t || '').trim());
        const ids = [];
        for (const text of topicTexts) {
          const idx = embedTexts.indexOf(text);
          if (idx >= 0) for (const hit of vectorMatches[idx] || []) ids.push(String(hit.id));
        }
        const topicCandidates = [...new Set(ids)].map((id) => candidateById.get(id)).filter(Boolean)
          .sort((a, b) => b._rank - a._rank);
        for (const item of topicCandidates.slice(0, 2)) {
          if (!seen.has(String(item.id))) { seen.add(String(item.id)); picked.push(item); }
        }
      }
      for (const item of candidates) {
        if (picked.length >= 16) break;
        if (!seen.has(String(item.id))) { seen.add(String(item.id)); picked.push(item); }
      }
      matches = picked;
    } else if (isAmbiguous && candidates.length) {
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
    // Merge exact calculator results as top, authoritative evidence so the model
    // reproduces the computed figures while still answering the FAQ parts.
    if (calcResults.length) {
      const calcEvidence = calcResults.map((r, i) => ({
        id: `calc-${i}`, article_id: `calc:${r.calcType}`, article_title: r.title,
        article_url: '', content: r.text, similarity: 1
      }));
      matches = [...calcEvidence, ...matches].slice(0, 14);
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
    const scopeText = `\n\nMANDATORY USER-SELECTED SCOPE: Product = ${selectedProduct.toUpperCase()}; Account model = ${selectedModel?.name || 'All models in the selected product family'}. ` +
      'Every supplied evidence item has already passed this scope filter. Never mention, compare, or borrow a rule from an Account model or product outside this selection. Product-wide policy evidence may be used when it applies to the selected family.';
    const allocationText = allocationQuestion && !selectedModel
      ? '\n\nALLOCATION OVERVIEW: The user selected all models. Do not answer from one Account perspective. Give a concise overall comparison of every materially different allocation rule supported by the evidence: standard aggregate FundedNext Account allocation, model-specific exceptions such as Stellar Lite, Challenge-phase treatment, regional limits, Stellar Instant purchase/scaling limits, and any verified U.S. exception. Clearly separate purchase allocation from scaled balance and do not merge them into one limit.'
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
    const multiPart = topicPlan.length > 1 || questionMarks >= 2 || listedParts >= 2 || (calcResults.length > 0 && (calc?.other?.length > 0));
    const multiPartText = multiPart
      ? '\n\nThis question has several parts. Answer them in this exact order and do not merge topics:\n' +
        topicPlan.map((topic, index) => `${index + 1}. ${topic.question}`).join('\n') +
        '\nAnswer every part the evidence supports, each as its own clearly separated numbered point. For any single part you cannot verify from the evidence, say only that that specific part needs checking — do not refuse or defer the entire answer because one part is unverified.'
      : '';
    // Exact computed results are provided as evidence — reproduce them verbatim.
    const calcMergeText = calcResults.length
      ? '\n\nParts of this question are calculations. The evidence items titled "Trade Calculator" are EXACT computed results — reproduce their formula and final figures verbatim for those parts and do NOT recompute them. Answer the remaining parts from the FAQ evidence. Cover every part.'
      : '';
    const formatText = '\n\nWrite all formulas and math in plain text using × ÷ + − = and parentheses. Never use LaTeX or markup such as \\frac, \\text, \\[, \\], or any backslash command.';
    const groundingText = '\n\nGROUNDING: Base your answer on the FAQ evidence above and prefer it over prior knowledge. If the evidence only partially covers the question, answer the part it supports and briefly note what is uncertain — you do not need to refuse. Only decline (and set CONFIDENCE low) if the evidence contains essentially nothing relevant to the question. Do not state specific rules, numbers, or permissions that are absent from the evidence, and do not cite a source that does not contain the claim.';
    // If the question is about a calculation (max lot, margin, pip value, lot
    // size, risk), push the model to use the calculator formulas that are in the
    // evidence and to ask for any missing number rather than assuming it.
    const calcText = concepts.groups.includes('calculator')
      ? '\n\nThis is a calculation question. If the FAQ evidence includes a Trade Calculator formula, use it: state the formula, then plug in the numbers. If a required value is missing (for example the current price, or the account/instrument leverage), give the formula and ask for that value instead of assuming it. Do not merge a calculation with a separate account limit — present them as distinct points.'
      : '';
    const emotion = clarity?.emotion || 'neutral';
    const empathyText = emotion === 'neutral'
      ? '\n\nTONE: Respond professionally and directly. Do not add a generic empathy sentence.'
      : `\n\nTONE: The client appears ${emotion}. Begin with one brief, natural, professional acknowledgement appropriate to that emotion, then answer directly. Do not say you detected an emotion. Do not over-apologize, admit fault, promise an outcome, or change any policy fact. Empathy affects tone only.`;
    const system = basePrompt + CORE_GUARDRAILS + brandingInstructions(brandRules) + snippetText + scopeText + allocationText + ambiguityText + multiPartText + calcText + calcMergeText + empathyText + formatText + groundingText +
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
    let usedFallback = false;
    const isLimit = (e) => /429|rate.?limit|too many requests|quota/i.test(String((e && e.message) || e));
    const runConfiguredFallback = async () => {
      if (!canFallback) return null;
      if (fallbackProvider === 'groq') {
        const fallbackPool = groqPool.length ? groqPool : (groqPrimary ? [{ key: groqPrimary }] : []);
        let fallbackError = null;
        for (const item of fallbackPool) {
          try { const result = await openaiChatDetailed(item.key, fallbackModel, messages, 'https://api.groq.com/openai/v1'); usedGroqKeyLabel = item.label || `Key ${item.id}`; return result; }
          catch (e) { fallbackError = e; }
        }
        if (fallbackError) throw fallbackError;
        throw new Error('No active Groq key is available for fallback.');
      }
      if (!openaiKey) throw new Error('No OpenAI key is available for fallback.');
      return openaiChatDetailed(openaiKey, fallbackModel, messages);
    };

    if (chatProvider === 'groq') {
      // Rotate over the key pool in a random order so concurrent users spread
      // across keys; on a rate-limited/failed key, try the next one.
      const pool = groqPool.length ? groqPool : (groqPrimary ? [{ key: groqPrimary }] : []);
      const order = pool.map((_, i) => i).sort(() => Math.random() - 0.5);
      let lastErr = null;
      // Try every key once, then retry one complete pass after a short pause.
      // This absorbs brief 429/5xx bursts without repeatedly hammering one key.
      for (let round = 0; round < 2 && !completion; round++) {
        if (round) await new Promise((resolve) => setTimeout(resolve, 700));
        for (const idx of order) {
          try {
            completion = await openaiChatDetailed(pool[idx].key, chatModel, messages, 'https://api.groq.com/openai/v1');
            usedGroqKeyLabel = pool[idx].label || `Key ${pool[idx].id}`;
            answerProvider = 'groq';
            break;
          } catch (e) { lastErr = e; completion = null; }
        }
      }
      if (!completion) {
        // Every Groq key failed. Only the master admin / creator falls back to GPT.
        if (canFallback) {
          try {
            completion = await runConfiguredFallback();
            answerProvider = fallbackProvider;
            usedFallback = true;
          } catch (e) { lastErr = e; }
        }
        if (!completion) {
          const limited = isLimit(lastErr);
          await logActivity({
            actorRole: access.role, sessionId: access.sessionId,
            userName: access.name, userEmail: access.email, authProvider: access.authProvider,
            questionWordCount: wordCount(question), eventType: 'query',
            provider: 'groq', model: chatModel, success: false,
            metadata: { reason: limited ? 'All Groq keys rate limited' : 'Groq request failed', attemptedGroqKeys: pool.map((item) => item.label || `Key ${item.id}`), durationMs: Date.now() - started }
          });
          return res.status(limited ? 429 : 502).json({
            error: limited
              ? 'All Groq keys have reached their usage limit right now. Please wait a moment and try again.'
              : 'Groq could not complete the answer. Please try again shortly, or ask an Admin to check the selected model.'
          });
        }
      }
    } else {
      try {
        completion = await openaiChatDetailed(openaiKey, chatModel, messages);
      } catch (primaryError) {
        if (!canFallback) throw primaryError;
        completion = await runConfiguredFallback();
        answerProvider = fallbackProvider;
        usedFallback = true;
      }
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

    // Guarantee the calculator reference is shown whenever a computation was
    // merged in, even if the model forgets to list it.
    for (let i = okCalc.length - 1; i >= 0; i--) {
      const r = okCalc[i];
      const aid = `calc:${r.calcType}`;
      if (!sources.some((s) => s._aid === aid)) {
        sources.unshift({ title: r.title, url: '', _aid: aid });
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
    let confidence = Math.min(modelConfidence, evidenceCap);
    let confidenceLabel = confidence >= 85 ? 'High confidence' : confidence >= 65 ? 'Review suggested' : 'Needs verification';
    let answer = cleanAnswer(applyBrandingReplacements(cleanAnswer(raw), brandRules));
    // An exact computation must not be thrown away as "unconfirmed".
    if (okCalc.length) confidence = Math.max(confidence, 74);
    // Only fall back to the safe message when the model itself is very unsure.
    if (confidence < 30 && !okCalc.length) answer = SAFE_UNCONFIRMED;

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
    sources = sources.map(({ _aid, ...rest }) => ({ ...rest, kind: /^(kb|calc):/.test(_aid || '') ? 'calculator' : 'faq' }));
    let usedCalculator = sources.some((s) => s.kind === 'calculator');

    // ---- Grounding verification --------------------------------------------
    // The grounding check is a CONFIDENCE signal, not a refusal switch. It lowers
    // confidence when the evidence weakly supports the answer, and only replaces
    // the answer when the evidence supports almost nothing (a clear fabrication).
    // This keeps the assistant useful for agents while catching invented claims.
    let groundingScore = null;
    if (smartRetrieval && answer !== SAFE_UNCONFIRMED && !usedCalculator) {
      const check = await verifyGrounding({
        question: clearQuestion || question, answer, context,
        provider: answerProvider, model: usedFallback ? fallbackModel : chatModel, openaiKey, groqKey: groqPrimary
      });
      if (check) {
        groundingScore = check.score;
        const topSimilarity = candidates.reduce((m, c) => Math.max(m, Number(c.similarity) || 0), 0);
        // Replace only when the verifier AND retrieval agree there's little support:
        // near-zero grounding score and no strongly matching FAQ evidence.
        if (check.score < 30 && topSimilarity < 0.5) {
          answer = 'I could not find a clear answer to this in the current FAQ knowledge, so I will not give an unverified answer. Please check the source directly or rephrase — and consider adding this to the FAQ if customers ask it often.';
          sources = [];
          segments = null;
          usedCalculator = false;
          confidence = Math.min(confidence, 22);
        } else {
          confidence = Math.max(0, Math.min(confidence, check.score + 20));
        }
        confidenceLabel = confidence >= 85 ? 'High confidence' : confidence >= 65 ? 'Review suggested' : 'Needs verification';
      }
    }

    // Structured, auditable confidence explanations. These are derived from
    // actual retrieval/verification measurements; the answer model cannot
    // invent the tooltip text.
    const confidenceReasons = [];
    if (sources.length === 1) confidenceReasons.push({ code: 'single_source', label: 'Only one applicable source supported this answer', impact: 'down' });
    if (sources.length >= 2) confidenceReasons.push({ code: 'multiple_sources', label: `${sources.length} applicable sources supported this answer`, impact: 'up' });
    if (selectedModel && matches.some((item) => modelsMentioned(`${item.article_title || ''}\n${item.content || ''}`, scopeCatalog.models).some((model) => model.slug === selectedModel.slug))) {
      confidenceReasons.push({ code: 'exact_scope', label: `Evidence matched ${selectedModel.name}`, impact: 'up' });
    }
    if (multiPart && sources.length < topicPlan.length) confidenceReasons.push({ code: 'partial_coverage', label: 'Some question parts have limited source coverage', impact: 'down' });
    if (groundingScore != null && groundingScore < 65) confidenceReasons.push({ code: 'grounding_reduced', label: `Grounding verification scored ${groundingScore}%`, impact: 'down' });
    if (groundingScore != null && groundingScore >= 85) confidenceReasons.push({ code: 'grounding_strong', label: `Grounding verification scored ${groundingScore}%`, impact: 'up' });

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
      model: `${usedFallback ? fallbackModel : chatModel}${usedGroqKeyLabel ? ` · Key: ${usedGroqKeyLabel}` : ''}`,
      inputTokens,
      outputTokens,
      estimatedCost: estimateCost(answerProvider, chatModel, inputTokens, outputTokens),
      metadata: {
        confidence, confidenceLabel, sourceCount: sources.length, scope,
        fallback: usedFallback, grounding: groundingScore, durationMs: Date.now() - started,
        smart: !!clarity, ambiguous: isAmbiguous, groqKeyLabel: usedGroqKeyLabel,
        questionPreview: question.slice(0, 180)
      }
    });

    return res.status(200).json({
      answer, sources, segments, answerProvider, usedFallback, confidence, confidenceLabel,
      confidenceReasons, selectedScope: { product: selectedProduct, model: selectedModel?.slug || 'all', label: selectedModel?.name || `All ${selectedProduct.toUpperCase()} models` },
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
