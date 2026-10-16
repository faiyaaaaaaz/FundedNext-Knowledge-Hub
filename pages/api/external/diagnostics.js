import { authenticateExternalApiKey } from '../../../lib/externalAccess';
import { supabaseAdmin } from '../../../lib/server';

function redact(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/(?:\+?\d[\s().-]*){8,15}\d/g, '[PHONE]')
    .replace(/\b(?:account|transaction|payment|reference|ticket|order)\s*(?:id|no|number|#)?\s*[:#-]?\s*[A-Z0-9-]{5,}\b/gi, '[IDENTIFIER]');
}

function safeMetadata(meta = {}) {
  const attempts = (meta.reviewTrace?.attempts || []).map((item) => ({
    provider: item.provider, model: item.model, status: item.status, httpStatus: item.httpStatus || null,
    durationMs: item.durationMs || null, error: redact(item.error || '').slice(0, 600), usage: item.usage || null
  }));
  return {
    status: meta.status, stage: meta.stage, durationMs: meta.durationMs, confidence: meta.confidence,
    confidenceLabel: meta.confidenceLabel, selectedProduct: meta.selectedProduct, selectedModel: meta.selectedModel,
    selectedScopeLabel: meta.selectedScopeLabel, scopeSource: meta.scopeSource, refusalReason: meta.refusalReason,
    question: redact(meta.question || meta.questionPreview).slice(0, 3000), answer: redact(meta.answer || meta.answerPreview).slice(0, 6000),
    interpretation: meta.interpretation || null, evidenceTrail: meta.evidenceTrail || null,
    processing: meta.processing || null, coverageSummary: meta.coverageSummary || null,
    noticeConflict: meta.noticeConflict || null, attempts
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const access = await authenticateExternalApiKey(req, 'diagnostics:read');
    if (!access) return res.status(401).json({ error: 'A developer API key is required.' });
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const sb = supabaseAdmin();
    const { data, error } = await sb.from('activity_logs')
      .select('id,created_at,provider,model,input_tokens,output_tokens,success,metadata')
      .eq('event_type', 'query').order('created_at', { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    const records = (data || []).map((row) => ({
      id: row.id, createdAt: row.created_at, provider: row.provider, model: row.model,
      inputTokens: row.input_tokens, outputTokens: row.output_tokens, success: row.success,
      ...safeMetadata(row.metadata || {})
    }));
    const failures = records.filter((row) => row.success === false || row.status === 'failed').length;
    const lowConfidence = records.filter((row) => Number(row.confidence || 100) < 65).length;
    const scopeRefusals = records.filter((row) => row.refusalReason || row.evidenceTrail?.acceptedCandidateCount === 0).length;
    return res.json({ generatedAt: new Date().toISOString(), redacted: true, count: records.length, summary: { failures, lowConfidence, scopeRefusals }, records });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
}
