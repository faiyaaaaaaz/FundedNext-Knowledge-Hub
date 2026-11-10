// A customer-provided code does not establish its meaning.
export function extractErrorCodes(text) {
  const matches = String(text || '').matchAll(/\b(?:error|error\s+code|code)\s*[:#-]?\s*([a-z]?[0-9][a-z0-9-]{2,15})\b/gi);
  return [...new Set([...matches].map((match) => match[1].toLowerCase()))].slice(0, 4);
}

export function unsupportedErrorCodes(question, paragraph, evidence) {
  const claim = String(paragraph || '').toLowerCase();
  const source = String(evidence || '').toLowerCase();
  return extractErrorCodes(question).filter((code) => {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i');
    return boundary.test(claim) && !boundary.test(source);
  });
}
