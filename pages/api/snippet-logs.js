import { authenticateRequest, supabaseAdmin } from '../../lib/server';

export const config = { api: { responseLimit: false } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabaseAdmin().from('activity_logs').select('*')
        .eq('event_type', 'snippet_usage').order('created_at', { ascending: false }).range(offset, offset + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const bySnippet = new Map();
    const queryIds = new Set();
    const users = new Set();
    for (const row of rows) {
      const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      const key = String(meta.snippetId || 'legacy');
      const current = bySnippet.get(key) || {
        snippetId: meta.snippetId || null, title: meta.title || 'Unknown snippet', uses: 0,
        queryIds: new Set(), users: new Set(), lastUsedAt: null
      };
      current.uses += 1;
      if (meta.queryLogId) { current.queryIds.add(String(meta.queryLogId)); queryIds.add(String(meta.queryLogId)); }
      if (row.user_email) { current.users.add(row.user_email); users.add(row.user_email); }
      if (!current.lastUsedAt || Date.parse(row.created_at) > Date.parse(current.lastUsedAt)) current.lastUsedAt = row.created_at;
      if (meta.title) current.title = meta.title;
      bySnippet.set(key, current);
    }
    const snippets = [...bySnippet.values()].map((item) => ({
      snippetId: item.snippetId, title: item.title, uses: item.uses,
      queriesAffected: item.queryIds.size, users: item.users.size, lastUsedAt: item.lastUsedAt
    })).sort((a, b) => b.uses - a.uses || Date.parse(b.lastUsedAt || 0) - Date.parse(a.lastUsedAt || 0));
    const events = rows.map((row) => ({
      id: row.id, createdAt: row.created_at, userName: row.user_name || '', userEmail: row.user_email || '',
      sessionId: row.session_id || '', ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {})
    }));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      summary: { uses: rows.length, snippets: snippets.length, queriesAffected: queryIds.size, users: users.size },
      snippets, events
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
