// Translate text only: attachment URLs, timestamps and message identity stay local.
export function translationBatches(items, maxCharacters = 9000, maxItems = 20) {
  const batches = []; let batch = []; let size = 0;
  for (const item of items) {
    if (batch.length && (batch.length >= maxItems || size + item.text.length > maxCharacters)) {
      batches.push(batch); batch = []; size = 0;
    }
    batch.push(item); size += item.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function parseTranslations(raw, items) {
  const value = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('Translation response was not valid JSON.'); }
  if (!Array.isArray(parsed) || parsed.length !== items.length) throw new Error('Translation response was incomplete.');
  const allowed = new Set(items.map((item) => item.id)); const results = new Map();
  for (const row of parsed) {
    if (!row || typeof row.id !== 'string' || !allowed.has(row.id) || results.has(row.id) ||
        typeof row.english !== 'string' || typeof row.language !== 'string') throw new Error('Translation response did not match the transcript.');
    results.set(row.id, { english: row.english.trim(), language: row.language.trim() });
  }
  return results;
}
