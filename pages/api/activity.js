import { authenticateRequest, supabaseAdmin } from '../../lib/server';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    const { data, error } = await supabaseAdmin().from('activity_logs').select('*').order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    const logs = data || [];
    const queries = logs.filter((item) => item.event_type === 'query');
    const sessions = new Set(logs.map((item) => item.session_id).filter(Boolean));
    return res.status(200).json({
      logs,
      summary: {
        events: logs.length,
        queries: queries.length,
        sessions: sessions.size,
        inputTokens: queries.reduce((sum, item) => sum + Number(item.input_tokens || 0), 0),
        outputTokens: queries.reduce((sum, item) => sum + Number(item.output_tokens || 0), 0),
        estimatedCost: queries.reduce((sum, item) => sum + Number(item.estimated_cost || 0), 0),
        failures: logs.filter((item) => item.success === false).length
      },
      identityNote: 'Shared-password sessions are tracked by device session. Individual names require Google authentication.'
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
