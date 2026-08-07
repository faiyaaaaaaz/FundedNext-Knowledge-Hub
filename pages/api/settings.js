import {
  authenticateRequest, saveKeys, keysStatus, getAgentAccessStatus,
  revokeAgentSessions, supabaseAdmin
} from '../../lib/server';

async function fullStatus() {
  const { count } = await supabaseAdmin().from('disputes').select('*', { count: 'exact', head: true }).eq('status', 'pending');
  return { ...(await keysStatus()), ...(await getAgentAccessStatus()), pendingDisputes: count || 0 };
}

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    if (req.method === 'GET') {
      return res.status(200).json(await fullStatus());
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { intercomToken, openaiKey, groqKey, chatModel, chatProvider, chatPrompt, allowedGoogleDomains, smartRetrieval } = body;
      await saveKeys({ intercomToken, openaiKey, groqKey, chatModel, chatProvider, chatPrompt, allowedGoogleDomains, smartRetrieval });
      if (body.agentPassword) return res.status(400).json({ error: 'Agent password login is disabled. Agents must use Google.' });
      if (body.logoutAgents) await revokeAgentSessions();
      return res.status(200).json({ ok: true, ...(await fullStatus()) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
