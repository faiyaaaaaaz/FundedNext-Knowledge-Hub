import { authenticateRequest, supabaseAdmin } from '../../lib/server';

const list = (value) => String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean).slice(0, 30);
const defaultKey = (email) => `activity_filter_default:${String(email).toLowerCase()}`;
const ACTIVITY_LIST_COLUMNS = [
  'id','session_id','user_name','user_email','actor_role','auth_provider','event_type','success','provider','model',
  'question_word_count','input_tokens','output_tokens','estimated_cost','created_at',
  'meta_question_preview:metadata->>questionPreview','meta_answer_preview:metadata->>answerPreview',
  'meta_status:metadata->>status','meta_stage:metadata->>stage','meta_reason:metadata->>reason','meta_error:metadata->>error',
  'meta_duration:metadata->>durationMs'
].join(',');

function normalizeListRow(row) {
  const metadata = {
    _compact: true,
    questionPreview: row.meta_question_preview || '', answerPreview: row.meta_answer_preview || '',
    status: row.meta_status || '', stage: row.meta_stage || '', reason: row.meta_reason || '', error: row.meta_error || '',
    durationMs: Number(row.meta_duration || 0)
  };
  const clean = { ...row, metadata };
  for (const key of Object.keys(clean)) if (key.startsWith('meta_')) delete clean[key];
  return clean;
}

function compactMetadata(value) {
  const meta = value && typeof value === 'object' ? value : {};
  const compact = { ...meta };
  // Full model request traces and captured source passages belong in the
  // diagnostics export/query-review screen. Sending them for hundreds of
  // activity rows made this ordinary list response several megabytes.
  delete compact.evidenceSnapshot;
  delete compact.reviewTrace;
  if (compact.question) compact.question = String(compact.question).slice(0, 8000);
  if (compact.answer) compact.answer = String(compact.answer).slice(0, 12000);
  if (Array.isArray(compact.sources)) compact.sources = compact.sources.slice(0, 12).map((source) => ({
    ...source, excerpt: String(source?.excerpt || '').slice(0, 1000)
  }));
  if (compact.evidenceTrail && typeof compact.evidenceTrail === 'object') compact.evidenceTrail = {
    ...compact.evidenceTrail,
    selectedForAnswer: (compact.evidenceTrail.selectedForAnswer || []).slice(0, 24),
    rejected: (compact.evidenceTrail.rejected || []).slice(0, 24)
  };
  return compact;
}

function applyFilters(rows, query) {
  const includeTypes = list(query.types), excludeTypes = list(query.excludeTypes), roles = list(query.roles);
  const status = String(query.status || '').toLowerCase(), search = String(query.search || '').trim().toLowerCase();
  const includeApi = ['1', 'true', 'yes'].includes(String(query.includeApi || '').toLowerCase());
  const includeApiAudits = ['1', 'true', 'yes'].includes(String(query.includeApiAudits || '').toLowerCase());
  return rows.filter((item) => {
    const type = String(item.event_type || '').toLowerCase();
    const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const external = String(item.auth_provider || '').toLowerCase() === 'external_api';
    const isAuditRecord = ['conversation_audit_job','conversation_audit_result','conversation_audit_dispute','conversation_audit_correction'].includes(type);
    const isDeveloperAuditRecord = isAuditRecord && (external || meta.auditOrigin === 'developer_api' || !!meta.externalKeyId || !!meta.keyId || String(item.user_email || '').toLowerCase() === 'master-admin@workspace.local');
    const isApiActivity = !isAuditRecord && (external || type === 'external_api_request' || !!meta.externalKeyId || !!meta.keyId);
    if (!includeApi && isApiActivity) return false;
    if (!includeApiAudits && isDeveloperAuditRecord) return false;
    if (includeTypes.length && !includeTypes.includes(type)) return false;
    if (excludeTypes.includes(type)) return false;
    if (roles.length && !roles.includes(String(item.actor_role || '').toLowerCase())) return false;
    if (status === 'success' && item.success === false) return false;
    if (status === 'failed' && item.success !== false) return false;
    if (!search) return true;
    return `${item.event_type || ''} ${item.user_name || ''} ${item.user_email || ''} ${item.provider || ''} ${item.model || ''} ${meta.question || ''} ${meta.answer || ''}`.toLowerCase().includes(search);
  });
}

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    const sb = supabaseAdmin();
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method === 'POST') {
      const action = req.body?.action;
      if (action === 'save-default') {
        const filters = req.body?.filters && typeof req.body.filters === 'object' ? req.body.filters : {};
        const { error } = await sb.from('settings').upsert({ key: defaultKey(access.email), value: JSON.stringify(filters) });
        if (error) throw error;
        return res.status(200).json({ ok: true, filters });
      }
      if (action === 'repair-attribution') {
        const { data, error } = await sb.from('activity_logs').select('id,session_id,user_name,user_email,actor_role,auth_provider,created_at').order('created_at', { ascending: true }).limit(10000);
        if (error) throw error;
        const identityBySession = new Map();
        for (const row of data || []) {
          if (row.session_id && row.user_email) identityBySession.set(row.session_id, row);
        }
        let repaired = 0, unrecoverable = 0;
        for (const row of data || []) {
          if (row.user_email) continue;
          const source = row.session_id ? identityBySession.get(row.session_id) : null;
          if (!source) { unrecoverable++; continue; }
          const update = await sb.from('activity_logs').update({ user_name: source.user_name, user_email: source.user_email, actor_role: row.actor_role || source.actor_role, auth_provider: row.auth_provider || source.auth_provider }).eq('id', row.id);
          if (update.error) throw update.error;
          repaired++;
        }
        return res.status(200).json({ repaired, unrecoverable, scanned: (data || []).length });
      }
      return res.status(400).json({ error: 'Unknown activity action.' });
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const action = String(req.query.action || 'list');
    if (action === 'default') {
      const { data, error } = await sb.from('settings').select('value').eq('key', defaultKey(access.email)).maybeSingle();
      if (error) throw error;
      let filters = null; try { filters = data?.value ? JSON.parse(data.value) : null; } catch { filters = null; }
      return res.status(200).json({ filters });
    }
    if (action === 'detail') {
      const id = String(req.query.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Activity ID is required.' });
      const { data, error } = await sb.from('activity_logs').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Activity record was not found.' });
      return res.status(200).json({ log: { ...data, metadata: compactMetadata(data.metadata) } });
    }
    const email = String(req.query.email || '').trim(), from = String(req.query.from || '').trim(), to = String(req.query.to || '').trim();
    const includeApi = ['1', 'true', 'yes'].includes(String(req.query.includeApi || '').toLowerCase());
    const includeApiAudits = ['1', 'true', 'yes'].includes(String(req.query.includeApiAudits || '').toLowerCase());
    const scopedQuery = () => {
      let query = sb.from('activity_logs').select(ACTIVITY_LIST_COLUMNS).order('created_at', { ascending: false }).limit(300);
      if (email) query = query.ilike('user_email', `%${email}%`);
      if (from) query = query.gte('created_at', `${from}T00:00:00+06:00`);
      if (to) query = query.lte('created_at', `${to}T23:59:59.999+06:00`);
      const includeTypes = list(req.query.types), excludeTypes = list(req.query.excludeTypes), roles = list(req.query.roles);
      if (includeTypes.length) query = query.in('event_type', includeTypes);
      if (excludeTypes.length) query = query.not('event_type', 'in', `(${excludeTypes.join(',')})`);
      if (roles.length) query = query.in('actor_role', roles);
      if (String(req.query.status || '').toLowerCase() === 'success') query = query.eq('success', true);
      if (String(req.query.status || '').toLowerCase() === 'failed') query = query.eq('success', false);
      const search = String(req.query.search || '').replace(/[^\p{L}\p{N}\s@-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (search) query = query.or(`event_type.ilike.%${search}%,user_name.ilike.%${search}%,user_email.ilike.%${search}%,provider.ilike.%${search}%,model.ilike.%${search}%,metadata->>question.ilike.%${search}%,metadata->>answer.ilike.%${search}%`);
      return query;
    };
    const auditEventTypes = '(conversation_audit_job,conversation_audit_result,conversation_audit_dispute,conversation_audit_correction)';
    const requests = [
      scopedQuery().or('auth_provider.is.null,auth_provider.neq.external_api').not('event_type', 'in', auditEventTypes),
      scopedQuery().in('event_type', ['conversation_audit_job','conversation_audit_result','conversation_audit_dispute','conversation_audit_correction']).or('auth_provider.is.null,auth_provider.neq.external_api').or('user_email.is.null,user_email.neq.master-admin@workspace.local')
    ];
    if (includeApi) requests.push(scopedQuery().eq('auth_provider', 'external_api').not('event_type', 'in', auditEventTypes));
    if (includeApiAudits) requests.push(scopedQuery().in('event_type', ['conversation_audit_job','conversation_audit_result','conversation_audit_dispute','conversation_audit_correction']));
    const responses = await Promise.all(requests);
    const failed = responses.find((response) => response.error); if (failed) throw failed.error;
    const unique = new Map(responses.flatMap((response) => response.data || []).map(normalizeListRow).map((row) => [row.id, row]));
    const rows = [...unique.values()].sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0)).slice(0, 500);
    // Search is already applied against the full stored fields in Postgres.
    // Re-applying it to the compact browser payload can incorrectly discard a
    // match when the matching text was outside the saved preview.
    const filtered = applyFilters(rows, { ...req.query, search: '' });
    const capped = filtered.length > 250;
    const logs = filtered.slice(0, 250).map((row) => ({ ...row, metadata: compactMetadata(row.metadata) }));
    const queries = logs.filter((item) => item.event_type === 'query'), sessions = new Set(logs.map((item) => item.session_id).filter(Boolean)), users = new Set(logs.map((item) => item.user_email).filter(Boolean));
    return res.status(200).json({ logs, capped, summary: { events: logs.length, queries: queries.length, users: users.size, sessions: sessions.size, questionWords: queries.reduce((sum, item) => sum + Number(item.question_word_count || 0), 0), inputTokens: queries.reduce((sum, item) => sum + Number(item.input_tokens || 0), 0), outputTokens: queries.reduce((sum, item) => sum + Number(item.output_tokens || 0), 0), estimatedCost: queries.reduce((sum, item) => sum + Number(item.estimated_cost || 0), 0), failures: logs.filter((item) => item.success === false).length } });
  } catch (error) { return res.status(500).json({ error: error.message }); }
}
