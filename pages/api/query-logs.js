import { authenticateRequest, supabaseAdmin } from '../../lib/server';

export const config = { maxDuration: 60, api: { responseLimit: false } };

function filtersFrom(source = {}) {
  return {
    from: String(source.from || '').trim(), to: String(source.to || '').trim(),
    email: String(source.email || '').trim(), name: String(source.name || '').trim(),
    provider: String(source.provider || '').trim().toLowerCase(), model: String(source.model || '').trim().toLowerCase(),
    scope: String(source.scope || '').trim().toLowerCase(), feedback: String(source.feedback || '').trim().toLowerCase(),
    search: String(source.search || '').trim().toLowerCase()
  };
}

function baseQuery(filters) {
  let query = supabaseAdmin().from('activity_logs').select('*').eq('event_type', 'query').order('created_at', { ascending: false }).order('id', { ascending: false });
  if (filters.from) query = query.gte('created_at', `${filters.from}T00:00:00+06:00`);
  if (filters.to) query = query.lte('created_at', `${filters.to}T23:59:59.999+06:00`);
  if (filters.email) query = query.ilike('user_email', `%${filters.email}%`);
  if (filters.name) query = query.ilike('user_name', `%${filters.name}%`);
  if (filters.provider) query = query.eq('provider', filters.provider);
  return query;
}

function mapRow(row, review = false) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    id: row.id, createdAt: row.created_at, userName: row.user_name || '', userEmail: row.user_email || '',
    actorRole: row.actor_role || '', question: meta.question || meta.questionPreview || '', answer: meta.answer || meta.answerPreview || meta.error || (meta.status === 'processing' ? `No completed response recorded. Last stage: ${meta.stage || 'Unknown'}. ${Date.now() - Date.parse(row.created_at) > 120000 ? 'The request may have been interrupted or timed out.' : 'The request may still be running.'}` : meta.reason || ''),
    questionWordCount: Number(row.question_word_count || 0), answerWordCount: Number(meta.answerWordCount || 0),
    provider: row.provider || '', model: row.model || '', inputTokens: Number(row.input_tokens || 0), outputTokens: Number(row.output_tokens || 0),
    estimatedCost: Number(row.estimated_cost || 0), success: row.success !== false, product: meta.selectedProduct || '',
    accountModel: meta.selectedModel || '', scopeLabel: meta.selectedScopeLabel || '', confidence: meta.confidence ?? null,
    confidenceLabel: meta.confidenceLabel || '', sourceCount: Number(meta.sourceCount || 0), sources: Array.isArray(meta.sources) ? meta.sources : [],
    feedback: meta.feedback || '', feedbackAt: meta.feedbackAt || '', feedbackBy: meta.feedbackBy || '',
    durationMs: Number(meta.durationMs || 0), fallback: !!meta.fallback, groqKeyLabel: meta.groqKeyLabel || '',
    questionTruncated: !!meta.questionTruncated, answerTruncated: !!meta.answerTruncated,
    interpretation: meta.interpretation && typeof meta.interpretation === 'object' ? meta.interpretation : null,
    evidenceTrail: meta.evidenceTrail && typeof meta.evidenceTrail === 'object' ? meta.evidenceTrail : null,
    processing: meta.processing && typeof meta.processing === 'object' ? meta.processing : null,
    refusalReason: meta.refusalReason || '', grounding: meta.grounding ?? null,
    status: meta.status || (row.success === false ? 'failed_or_incomplete' : 'legacy_status_not_recorded'),
    stage: meta.stage || null, error: meta.error || null, reason: meta.reason || null,
    questionCoverage: meta.questionCoverage || null, coverageSummary: meta.coverageSummary || null,
    noticeConflict: meta.noticeConflict || null,
    ...(review ? {
      evidenceSnapshot: meta.evidenceSnapshot || null,
      reviewTrace: meta.reviewTrace || null,
      availability: {
        question: meta.question ? 'recorded' : meta.questionPreview ? 'preview_only' : 'not_recorded',
        answer: meta.answer ? 'recorded' : meta.answerPreview ? 'preview_only' : 'not_recorded',
        sourcePassages: meta.evidenceSnapshot ? 'captured_at_request_time' : 'not_recorded',
        answerModelRequests: meta.reviewTrace ? 'recorded' : 'not_recorded',
        fullSourceArticleVersions: 'not_recorded'
      }
    } : {})
  };
}

function matches(row, filters) {
  if (filters.scope && row.product !== filters.scope) return false;
  if (filters.model && !row.model.toLowerCase().includes(filters.model)) return false;
  if (filters.feedback === 'any' && !row.feedback) return false;
  if (filters.feedback === 'none' && row.feedback) return false;
  if (['helpful', 'great'].includes(filters.feedback) && row.feedback !== filters.feedback) return false;
  return !filters.search || `${row.question} ${row.answer} ${row.scopeLabel} ${row.model}`.toLowerCase().includes(filters.search);
}

async function fetchAll(filters, ids = null, review = false) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    let query = baseQuery(filters);
    if (ids) query = query.in('id', ids);
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows.map(row => mapRow(row, review)).filter((row) => matches(row, filters));
}

async function buildReport(ids) {
  const queries = [];
  for (let start = 0; start < ids.length; start += 100) {
    queries.push(...await fetchAll(filtersFrom(), ids.slice(start, start + 100), true));
  }
  const approvedDisputes = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabaseAdmin().from('disputes')
      .select('id,status,question,answer,dispute_reason,approval_reason,reviewed_at,created_at,user_name,user_email,provider,confidence,sources,generated_title,generated_snippet,generated_at')
      .in('status', ['approved', 'snippet_generated']).order('id', { ascending: true }).range(offset, offset + 499);
    if (error) throw error;
    for (const dispute of data || []) {
      const linked = (dispute.sources || []).filter(source => source.type === 'query_log').map(source => String(source.id));
      approvedDisputes.push({ ...dispute, linkedQueryIds: linked, relatesToSelection: linked.some(id => ids.includes(id)) });
    }
    if (!data || data.length < 500) break;
  }
  const found = new Set(queries.map(query => String(query.id)));
  return {
    schema: 'fundednext-evaluation-report', version: 1, exportedAt: new Date().toISOString(),
    contents: 'Selected recorded queries plus all approved disputes as a separately labelled evaluation reference library.',
    limitations: [
      'Observable processing and answer-model request evidence only; no private hidden chain-of-thought.',
      'Historical missing evidence is not reconstructed from current sources. Linked live articles may have changed.',
      'Passage hashes identify captured text; they do not establish that a full article version was retained.',
      'A started attempt with no completed outcome may have been interrupted; absence of an error is not proof of success.',
      'Snippet-generated disputes passed approval in this application and are included. Pending and rejected disputes are excluded.',
      'Interpretation and verification model calls are summarized where recorded; detailed request traces cover answer generation and its retries.'
    ],
    requestedQueryIds: ids, missingQueryIds: ids.filter(id => !found.has(id)),
    counts: { queries: queries.length, approvedDisputes: approvedDisputes.length },
    queries, approvedDisputes
  };
}

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST') {
      if (req.body?.action !== 'export') return res.status(400).json({ error: 'Unknown report action.' });
      const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String).filter(Boolean))];
      if (!ids.length) return res.status(400).json({ error: 'Select at least one recorded query.' });
      const report = await buildReport(ids);
      res.setHeader('Content-Disposition', 'attachment; filename="fundednext-review.json"');
      return res.status(200).json(report);
    }
    if (req.method === 'GET') return res.status(200).json({ logs: await fetchAll(filtersFrom(req.query)), capped: false });
    if (req.method === 'DELETE') {
      if (req.body?.confirm !== 'PERMANENT_DELETE') return res.status(400).json({ error: 'Permanent deletion was not confirmed.' });
      const ids = req.body?.mode === 'filter'
        ? (await fetchAll(filtersFrom(req.body.filters))).map((row) => row.id)
        : Array.from(new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter(Boolean)));
      if (!ids.length) return res.status(200).json({ deleted: 0 });
      let deleted = 0;
      for (let index = 0; index < ids.length; index += 200) {
        const { data, error } = await supabaseAdmin().from('activity_logs').delete().eq('event_type', 'query').in('id', ids.slice(index, index + 200)).select('id');
        if (error) throw error;
        deleted += (data || []).length;
      }
      return res.status(200).json({ deleted });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) { return res.status(500).json({ error: error.message }); }
}
