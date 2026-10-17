function countWords(value) {
  return (String(value || '').trim().match(/\S+/g) || []).length;
}

// Clear, explicitly scoped questions already have deterministic model, intent,
// typo, and concept handling in the search route. Reserve the extra LLM pass
// for cases where it can materially improve recall or prevent a wrong answer.
export function shouldUseLlmClarifier({
  question,
  smartRetrieval,
  hasSelectedModel,
  conceptGroupCount = 0,
  typoCorrectionChanged = false
}) {
  if (!smartRetrieval) return false;
  const text = String(question || '').trim();
  const questionMarks = (text.match(/\?/g) || []).length;
  const listedParts = (text.match(/(?:^|\n)\s*(?:\d+[.)]|[-*])\s/g) || []).length;
  const vagueShortReference = countWords(text) <= 14 &&
    /\b(?:it|this|that|they|them|those|these|same|there)\b/i.test(text) &&
    Number(conceptGroupCount || 0) === 0;
  const distinctRuleTopics = [
    /\b(?:daily loss|maximum loss|max loss|drawdown|mll)\b/i,
    /\b(?:expert advisors?|eas?|automated trading|trading bots?)\b/i,
    /\b(?:news trading|trade during news|news events?)\b/i,
    /\b(?:performance rewards?|payouts?|withdrawals?|profit split)\b/i,
    /\b(?:minimum trading days?|profit targets?|consistency rule)\b/i,
    /\b(?:reset|restart|scale(?:-?up| up|ing)?)\b/i
  ].filter((pattern) => pattern.test(text)).length;
  const compoundQuestion = questionMarks > 1 || listedParts > 1 || distinctRuleTopics > 1 ||
    /\b(?:also|and (?:can|could|do|does|how|what|when|where|why|is|are|will|would)|second(?:ly)?|another question)\b/i.test(text);
  return !hasSelectedModel || text.length > 180 || compoundQuestion || vagueShortReference || typoCorrectionChanged;
}
