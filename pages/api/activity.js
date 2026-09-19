import { authenticateRequest, supabaseAdmin } from '../../lib/server';

const list = (value) => String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean).slice(0, 30);
const defaultKey = (email) => `activity_filter_default:${String(email).toLowerCase()}`;

function applyFilters(rows, query) {
  const includeTypes = list(query.types), excludeTypes = list(query.excludeTypes), roles = list(query.roles);
  const status = String(query.status || '').toLowerCase(), search = String(query.search || '').trim().toLowerCase();
  return rows.filter((item) => {
    const type = String(item.event_type || '').toLowerCase();
    if (includeTypes.length && !includeTypes.includes(type)) return false;
    if (excludeTypes.includes(type)) return false;
    if (roles.length && !roles.includes(String(item.actor_role || '').toLowerCase())) return false;
    if (status === 'success' && item.success === false) return false;
    if (status === 'failed' && item.success !== false) return false;
    if (!search) return true;
    const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    return `${item.event_type || ''} ${item.user_name || ''} ${item.user_email || ''} ${item.provider || ''} ${item.model || ''} ${meta.question || ''} ${meta.answer || ''}`.toLowerCase().includes(search);
  });
}

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    const sb = supabaseAdmin();
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
    const email = String(req.query.email || '').trim(), from = String(req.query.from || '').trim(), to = String(req.query.to || '').trim();
    let query = sb.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(1000);
    if (email) query = query.ilike('user_email', `%${email}%`);
    if (from) query = query.gte('created_at', `${from}T00:00:00+06:00`);
    if (to) query = query.lte('created_at', `${to}T23:59:59.999+06:00`);
    const { data, error } = await query;
    if (error) throw error;
    const logs = applyFilters(data || [], req.query);
    const queries = logs.filter((item) => item.event_type === 'query'), sessions = new Set(logs.map((item) => item.session_id).filter(Boolean)), users = new Set(logs.map((item) => item.user_email).filter(Boolean));
    return res.status(200).json({ logs, summary: { events: logs.length, queries: queries.length, users: users.size, sessions: sessions.size, questionWords: queries.reduce((sum, item) => sum + Number(item.question_word_count || 0), 0), inputTokens: queries.reduce((sum, item) => sum + Number(item.input_tokens || 0), 0), outputTokens: queries.reduce((sum, item) => sum + Number(item.output_tokens || 0), 0), estimatedCost: queries.reduce((sum, item) => sum + Number(item.estimated_cost || 0), 0), failures: logs.filter((item) => item.success === false).length } });
  } catch (error) { return res.status(500).json({ error: error.message }); }
}
