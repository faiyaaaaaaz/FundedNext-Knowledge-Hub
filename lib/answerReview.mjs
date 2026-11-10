// The reviewer sees only the evidence cited by each paragraph.
export function buildReviewItems(segments, sources, matches) {
  return (segments || []).map((segment, index) => {
    const citations = (segment.refs || []).map((ref) => sources[ref - 1]).filter(Boolean);
    const relevant = (matches || []).filter((item) => citations.some((source) =>
      source.url ? source.url === item.article_url : source.title === item.article_title));
    return {
      index,
      text: String(segment.text || ''),
      evidence: relevant.map((item) => `${item.article_title || ''}\n${item.content || ''}`).join('\n\n').slice(0, 5000),
      // A deterministic unverified statement is not a factual claim to validate.
      safeUncertainty: !citations.length && /^(?:I cannot verify the meaning or cause of error |Part \d+ still needs verification:)/.test(String(segment.text || ''))
    };
  });
}

export function validateReview(items, value) {
  if (!Array.isArray(value?.reviews)) return null;
  const result = new Map();
  for (const row of value.reviews) {
    if (!Number.isInteger(row?.index) || typeof row.supported !== 'boolean' ||
        row.index < 0 || row.index >= items.length || result.has(row.index)) return null;
    result.set(row.index, row.supported);
  }
  for (const item of items) {
    if (!item.safeUncertainty && !result.has(item.index)) return null;
  }
  return items.map((item) => item.safeUncertainty ||
    (item.text.length <= 3500 && !!item.evidence && result.get(item.index) === true));
}
