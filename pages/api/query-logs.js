import { authenticateRequest, supabaseAdmin } from '../../lib/server';

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
  let query = supabaseAdmin().from('activity_logs').select('*').eq('event_type', 'query').order('created_at', { ascending: false });
  if (filters.from) query = query.gte('created_at', `${filters.from}T00:00:00+06:00`);
  if (filters.to) query = query.lte('created_at', `${filters.to}T23:59:59.999+06:00`);
  if (filters.email) query = query.ilike('user_email', `%${filters.email}%`);
  if (filters.name) query = query.ilike('user_name', `%${filters.name}%`);
  if (filters.provider) query = query.eq('provider', filters.provider);
  return query;
}

function mapRow(row) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    id: row.id, createdAt: row.created_at, userName: row.user_name || '', userEmail: row.user_email || '',
    actorRole: row.actor_role || '', question: meta.question || meta.questionPreview || '', answer: meta.answer || meta.answerPreview || '',
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
    refusalReason: meta.refusalReason || '', grounding: meta.grounding ?? null
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

async function fetchAll(filters) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await baseQuery(filters).range(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows.map(mapRow).filter((row) => matches(row, filters));
}

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
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
