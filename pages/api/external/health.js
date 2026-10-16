import { auditConnections } from '../../../lib/audits';
import { authenticateExternalApiKey } from '../../../lib/externalAccess';
import { supabaseAdmin } from '../../../lib/server';

export const config = { maxDuration: 60 };

function checked(result) {
  if (result.error) throw new Error(result.error.message);
  return Number(result.count || 0);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const access = await authenticateExternalApiKey(req, 'diagnostics:read');
    if (!access) return res.status(401).json({ error: 'A developer API key is required.' });
    const sb = supabaseAdmin();
    const [connections, articles, activeNotices, activeSnippets, auditResults, recentFailures] = await Promise.all([
      auditConnections(),
      sb.from('articles').select('intercom_id', { count: 'exact', head: true }),
      sb.from('notices').select('entry_id', { count: 'exact', head: true }).eq('status', 'active'),
      sb.from('ai_snippets').select('id', { count: 'exact', head: true }).eq('active', true),
      sb.from('activity_logs').select('id', { count: 'exact', head: true }).eq('event_type', 'conversation_audit_result').eq('success', true),
      sb.from('activity_logs').select('id', { count: 'exact', head: true }).eq('success', false).gte('created_at', new Date(Date.now() - 86400000).toISOString())
    ]);
    return res.json({
      connected: connections.state !== 'offline', checkedAt: new Date().toISOString(), connections,
      knowledge: { articles: checked(articles), activeNotices: checked(activeNotices), activeSnippets: checked(activeSnippets) },
      audits: { completedEvaluations: checked(auditResults) }, recentFailures24h: checked(recentFailures),
      permissions: access.scopes
    });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
}
