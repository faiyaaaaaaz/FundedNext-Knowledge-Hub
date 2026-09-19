import { authenticateRequest, supabaseAdmin } from '../../lib/server';
import { gzipSync } from 'zlib';

async function readAll(queryFactory) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await queryFactory().range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

export const config = { api: { responseLimit: false } };

export async function buildSnippetUsageReport(sb = supabaseAdmin()) {
  const [queryRows, legacyRows] = await Promise.all([
      readAll(() => sb.from('activity_logs').select('id,created_at,user_name,user_email,session_id,metadata').eq('event_type', 'query').order('created_at', { ascending: false })),
      readAll(() => sb.from('activity_logs').select('*').eq('event_type', 'snippet_usage').order('created_at', { ascending: false }))
  ]);
  const events = [];
  const queryIdsWithModernTrace = new Set();
  for (const row of queryRows) {
      const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      const uses = Array.isArray(meta.snippetsUsed) ? meta.snippetsUsed : [];
      if (uses.length) queryIdsWithModernTrace.add(String(row.id));
      for (const use of uses) events.push({
        id: `query-${row.id}-${use.snippetId}`, createdAt: row.created_at,
        userName: row.user_name || '', userEmail: row.user_email || '', sessionId: row.session_id || '',
        queryLogId: row.id, question: meta.question || meta.questionPreview || '', questionPreview: String(meta.question || meta.questionPreview || '').slice(0, 180),
        selectedProduct: meta.selectedProduct || '', selectedModel: meta.selectedModel || '', selectedScopeLabel: meta.selectedScopeLabel || '',
        snippetId: use.snippetId || null, title: use.title || 'Unknown snippet', triggerTerms: use.triggerTerms || '', instruction: use.instruction || '',
        instructionHash: use.instructionHash || '', matchScore: use.matchScore ?? null,
        injection: use.injection || 'included_for_evidence_checked_review', influence: use.influence || 'not_determinable_from_model_output', traceVersion: 'query-record'
      });
  }
  // Keep historical standalone entries, but never count the same query twice.
  for (const row of legacyRows) {
      const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      if (meta.queryLogId && queryIdsWithModernTrace.has(String(meta.queryLogId))) continue;
      events.push({
        id: `legacy-${row.id}`, createdAt: row.created_at, userName: row.user_name || '', userEmail: row.user_email || '', sessionId: row.session_id || '',
        ...meta, queryLogId: meta.queryLogId || null, title: meta.title || 'Unknown snippet',
        injection: 'recorded_by_legacy_activity_event', influence: 'not_recorded_for_legacy_event', traceVersion: 'legacy-activity'
      });
  }
  const bySnippet = new Map(), queryIds = new Set(), users = new Set();
  for (const event of events) {
      const key = String(event.snippetId || 'legacy');
      const current = bySnippet.get(key) || { snippetId: event.snippetId || null, title: event.title || 'Unknown snippet', uses: 0, queryIds: new Set(), users: new Set(), lastUsedAt: null };
      current.uses += 1;
      if (event.queryLogId) { current.queryIds.add(String(event.queryLogId)); queryIds.add(String(event.queryLogId)); }
      if (event.userEmail) { current.users.add(event.userEmail); users.add(event.userEmail); }
      if (!current.lastUsedAt || Date.parse(event.createdAt) > Date.parse(current.lastUsedAt)) current.lastUsedAt = event.createdAt;
      bySnippet.set(key, current);
  }
  const snippets = [...bySnippet.values()].map((item) => ({ snippetId: item.snippetId, title: item.title, uses: item.uses, queriesAffected: item.queryIds.size, users: item.users.size, lastUsedAt: item.lastUsedAt }))
    .sort((a, b) => b.uses - a.uses || Date.parse(b.lastUsedAt || 0) - Date.parse(a.lastUsedAt || 0));
  events.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  return { summary: { uses: events.length, snippets: snippets.length, queriesAffected: queryIds.size, users: users.size }, snippets, events };
}

function compactEvent(event) {
  return {
    id: event.id, createdAt: event.createdAt, queryLogId: event.queryLogId,
    userName: event.userName, userEmail: event.userEmail, question: event.question,
    selectedProduct: event.selectedProduct, selectedModel: event.selectedModel, selectedScopeLabel: event.selectedScopeLabel,
    snippetId: event.snippetId, title: event.title, triggerTerms: event.triggerTerms,
    instruction: event.instruction, instructionHash: event.instructionHash, matchScore: event.matchScore,
    injection: event.injection, influence: event.influence, traceVersion: event.traceVersion
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    const report = await buildSnippetUsageReport();
    res.setHeader('Cache-Control', 'no-store');
    if (String(req.query.download || '') === '1') {
      const exportBody = { schema: 'fundednext-snippet-usage-diagnostics', version: 2, exportedAt: new Date().toISOString(), summary: report.summary, snippets: report.snippets, events: report.events.map(compactEvent) };
      const compressed = gzipSync(Buffer.from(JSON.stringify(exportBody)), { level: 9 });
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', 'attachment; filename="fundednext-snippet-usage.json.gz"');
      res.setHeader('Content-Length', String(compressed.length));
      return res.status(200).send(compressed);
    }
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 30));
    return res.status(200).json({ summary: report.summary, snippets: report.snippets, events: report.events.slice(offset, offset + limit), totalEvents: report.events.length, nextOffset: offset + limit < report.events.length ? offset + limit : null });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
