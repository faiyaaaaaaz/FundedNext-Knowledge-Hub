import {
  authenticateRequest, saveKeys, keysStatus, getAgentAccessStatus,
  setAgentPassword, revokeAgentSessions
} from '../../lib/server';

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    if (req.method === 'GET') {
      return res.status(200).json({ ...(await keysStatus()), ...(await getAgentAccessStatus()) });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { intercomToken, openaiKey, groqKey, chatModel, chatProvider, chatPrompt } = body;
      await saveKeys({ intercomToken, openaiKey, groqKey, chatModel, chatProvider, chatPrompt });
      if (body.agentPassword) await setAgentPassword(body.agentPassword);
      else if (body.logoutAgents) await revokeAgentSessions();
      return res.status(200).json({ ok: true, ...(await keysStatus()), ...(await getAgentAccessStatus()) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
