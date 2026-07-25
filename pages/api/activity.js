import { authenticateRequest, supabaseAdmin } from '../../lib/server';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    const email = String(req.query.email || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    let query = supabaseAdmin().from('activity_logs').select('*').order('created_at', { ascending: false }).limit(1000);
    if (email) query = query.ilike('user_email', `%${email}%`);
    if (from) query = query.gte('created_at', `${from}T00:00:00+06:00`);
    if (to) query = query.lte('created_at', `${to}T23:59:59.999+06:00`);
    const { data, error } = await query;
    if (error) throw error;

    const logs = data || [];
    const queries = logs.filter((item) => item.event_type === 'query');
    const sessions = new Set(logs.map((item) => item.session_id).filter(Boolean));
    const users = new Set(logs.map((item) => item.user_email).filter(Boolean));
    return res.status(200).json({
      logs,
      summary: {
        events: logs.length,
        queries: queries.length,
        users: users.size,
        sessions: sessions.size,
        questionWords: queries.reduce((sum, item) => sum + Number(item.question_word_count || 0), 0),
        inputTokens: queries.reduce((sum, item) => sum + Number(item.input_tokens || 0), 0),
        outputTokens: queries.reduce((sum, item) => sum + Number(item.output_tokens || 0), 0),
        estimatedCost: queries.reduce((sum, item) => sum + Number(item.estimated_cost || 0), 0),
        failures: logs.filter((item) => item.success === false).length
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
