const STOP_WORDS = new Set([
  'about','account','accounts','after','again','also','another','because','before','being','challenge','client',
  'could','does','from','fundednext','have','into','please','should','support','than','that','their','there',
  'these','they','this','trader','trading','what','when','where','which','with','would','your'
]);

export function normalizeEvidenceText(value) {
  return String(value || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function meaningfulEvidenceTerms(value, limit = 80) {
  return [...new Set((normalizeEvidenceText(value).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [])
    .filter((term) => term.length >= 4 && !STOP_WORDS.has(term)))].slice(0, limit);
}

// Infer product from the source itself. Explicit titles take priority over broad
// database metadata because a Notice marked "both" can still discuss one
// product-specific workflow.
export function inferEvidenceProduct({ title = '', url = '', text = '' } = {}) {
  const heading = normalizeEvidenceText(title).toLowerCase();
  const body = normalizeEvidenceText(text).toLowerCase();
  const href = normalizeEvidenceText(url).toLowerCase();
  if (/\bfn\s*markets?\b|\bfnmarkets\b/.test(heading)) return 'fnmarkets';
  if (/\bfundednext\s+futures\b|\bfutures\s+(?:account|challenge|rules?|platform|payout|withdrawal|kyc)\b/.test(heading)) return 'futures';
  if (/\bfundednext\s+cfds?\b|\bcfd\s+(?:account|challenge|rules?|platform|payout|withdrawal|kyc)\b|\bstellar\b/.test(heading)) return 'cfd';
  if (/helpfutures\.fundednext\.com/.test(href)) return 'futures';
  if (/help\.fnmarkets\.com/.test(href)) return 'fnmarkets';
  if (/\b(?:tradovate|ninjatrader)\b/.test(body) && !/\b(?:mt4|mt5|metatrader|cfd|stellar)\b/.test(body)) return 'futures';
  if (/\b(?:mt4|mt5|metatrader|cfd|stellar)\b/.test(body) && !/\b(?:tradovate|ninjatrader|futures)\b/.test(body)) return 'cfd';
  if (/help\.fundednext\.com/.test(href)) return 'cfd';
  return null;
}

export function evidenceAppliesToProduct(source, requestedProduct = 'both', storedProduct = 'both') {
  const requested = String(requestedProduct || 'both').toLowerCase();
  if (requested === 'both') return { applies: true, inferredProduct: inferEvidenceProduct(source), reason: '' };
  const inferredProduct = inferEvidenceProduct(source);
  if (inferredProduct && inferredProduct !== requested) {
    return { applies: false, inferredProduct, reason: `Source text identifies ${inferredProduct}; request requires ${requested}` };
  }
  const stored = String(storedProduct || 'both').toLowerCase();
  if (stored !== 'both' && stored !== requested) {
    return { applies: false, inferredProduct, reason: `Stored product is ${stored}; request requires ${requested}` };
  }
  return { applies: true, inferredProduct, reason: '' };
}

export function inferConversationProduct(value) {
  const text = normalizeEvidenceText(value).toLowerCase();
  const futures = /\bfundednext\s+futures\b|\bfutures\s+(?:account|challenge|rules?|platform)\b|\btradovate\b|\bninjatrader\b/.test(text);
  const cfd = /\bfundednext\s+cfds?\b|\bcfd\s+(?:account|challenge|rules?|platform)\b|\b(?:mt4|mt5|metatrader|stellar)\b/.test(text);
  const fnmarkets = /\bfn\s*markets?\b|\bfnmarkets\b/.test(text);
  const found = [['futures', futures], ['cfd', cfd], ['fnmarkets', fnmarkets]].filter(([, yes]) => yes).map(([product]) => product);
  return found.length === 1 ? found[0] : 'both';
}

export function buildEmbeddingPlan({ question = '', clearQuestion = '', selectedModelName = '', clarityQueries = [], topics = [], expansions = [] } = {}) {
  const topicTexts = (topics || []).map((topic) => normalizeEvidenceText(topic?.question || topic)).filter(Boolean);
  const base = [question, clearQuestion];
  if (selectedModelName) base.push(`${question} ${selectedModelName}`, `${selectedModelName} exceptions restrictions eligibility policy`);
  // Every explicit customer question receives a vector before optional helper
  // expansions. The old global slice could silently omit the final questions.
  const optional = [...clarityQueries, ...topics.flatMap((topic) => topic?.queries || []), ...expansions];
  const maximum = Math.max(20, Math.min(32, topicTexts.length + 8));
  return [...new Set([...base, ...topicTexts, ...optional].map(normalizeEvidenceText).filter(Boolean))].slice(0, maximum);
}

export function evidenceBudgetForTopics(topicCount = 1) {
  const count = Math.max(1, Number(topicCount) || 1);
  if (count === 1) return 7;
  if (count <= 4) return 12;
  if (count <= 12) return 16;
  return 20;
}

export function focusedEvidenceExcerpt(content, query, maxChars = 1800) {
  const source = String(content || '').trim();
  if (source.length <= maxChars) return source;
  const terms = meaningfulEvidenceTerms(query, 40);
  if (!terms.length) return `${source.slice(0, maxChars).trim()}…`;
  const pieces = source.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9])/).map((text, index) => ({ text: text.trim(), index })).filter((item) => item.text);
  const scored = pieces.map((item) => {
    const lower = item.text.toLowerCase();
    const hits = terms.filter((term) => lower.includes(term));
    return { ...item, score: hits.length + (hits.length / Math.max(1, terms.length)) * 4 };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  if (!scored.length) return `${source.slice(0, maxChars).trim()}…`;
  const selected = [];
  let used = 0;
  for (const item of scored) {
    if (selected.some((current) => current.index === item.index)) continue;
    const remaining = maxChars - used - (selected.length ? 2 : 0);
    if (remaining < 120) break;
    selected.push({ ...item, text: item.text.slice(0, remaining) });
    used += Math.min(item.text.length, remaining) + (selected.length > 1 ? 2 : 0);
  }
  const excerpt = selected.sort((a, b) => a.index - b.index).map((item) => item.text).join('\n\n').trim();
  return `${excerpt}${excerpt.length < source.length ? '…' : ''}`;
}

export function evidenceRelevanceScore(source, queries) {
  const title = normalizeEvidenceText(source?.title || source?.article_title).toLowerCase();
  const text = normalizeEvidenceText(source?.text || source?.content || source?.answer_text).toLowerCase();
  let best = 0;
  for (const query of queries || []) {
    const terms = meaningfulEvidenceTerms(query, 50);
    if (!terms.length) continue;
    const titleHits = terms.filter((term) => title.includes(term)).length;
    const textHits = terms.filter((term) => text.includes(term)).length;
    best = Math.max(best, titleHits * 4 + textHits + (Math.max(titleHits, textHits) / terms.length) * 8);
  }
  return best;
}

export function extractAuditEvidenceQueries(transcript, limit = 8) {
  const lines = String(transcript || '').split(/\r?\n/);
  const messages = lines.map((line, index) => {
    const marker = line.indexOf(': ');
    if (marker < 0) return null;
    const header = line.slice(0, marker);
    if (!/\|\s*(?:CLIENT|AGENT)\s*\|/i.test(header)) return null;
    const text = normalizeEvidenceText(line.slice(marker + 2));
    if (text.length < 12 || /^\[[A-Z_]+\]$/.test(text)) return null;
    const client = /\|\s*CLIENT\s*\|/i.test(header);
    const score = (client ? 4 : 1) + ((text.match(/\?/g) || []).length * 3) + Math.min(4, meaningfulEvidenceTerms(text).length / 5);
    return { text: text.slice(0, 1800), index, score };
  }).filter(Boolean);
  const selected = messages.sort((a, b) => b.score - a.score || b.index - a.index).slice(0, limit).sort((a, b) => a.index - b.index);
  return [...new Set(selected.map((item) => item.text))];
}

export function asksForPrivateAccountState(value) {
  const text = normalizeEvidenceText(value).toLowerCase();
  const personal = /\b(?:my|our)\s+(?:account|profile|warning|breach|kyc|payout|reward|status)\b|\bam i\b|\bdo i need\b/.test(text);
  const state = /\b(?:current|currently|status|standing|active|eligible|verified|breached|compliant|warning|need to take action|action required)\b/.test(text);
  return personal && state;
}

export function repairPrivateAccountStateClaims(answer, topics = []) {
  if (!(topics || []).some((topic) => asksForPrivateAccountState(topic?.question || topic))) return String(answer || '');
  let value = String(answer || '')
    .replace(/(?:your account|you)\s+(?:is|are)\s+(?:currently\s+)?(?:in good standing|compliant|eligible|active|verified)[^.?!]*[.?!]?/gi, '')
    .replace(/you\s+(?:do not|don't)\s+need\s+to\s+take\s+any\s+action[^.?!]*[.?!]?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const boundary = 'I can explain the applicable policy, but I cannot verify the current status of your account from general policy information alone. Please follow the instructions in the warning or ask Support to review the account record.';
  if (!/cannot verify the current status of your account/i.test(value)) value = `${value}\n\n${boundary}`.trim();
  return value;
}
