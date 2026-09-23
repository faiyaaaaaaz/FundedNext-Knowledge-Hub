import {
  authenticateRequest, saveKeys, keysStatus, getAgentAccessStatus,
  revokeAgentSessions, setMasterPassword, disableMasterPassword, logActivity, supabaseAdmin
} from '../../lib/server';

async function fullStatus(access) {
  const { count } = await supabaseAdmin().from('disputes').select('*', { count: 'exact', head: true }).eq('status', 'pending');
  return { ...(await keysStatus()), ...(await getAgentAccessStatus()), pendingDisputes: count || 0, currentAuthProvider: access?.authProvider || null, canManageMasterPassword: access?.authProvider === 'google' };
}

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    if (req.method === 'GET') {
      return res.status(200).json(await fullStatus(access));
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { intercomToken, openaiKey, groqKey, chatModel, chatProvider, chatPrompt, allowedGoogleDomains, smartRetrieval, normalUserGptFallback, adminAutoFallback, fallbackProvider, fallbackModel } = body;
      await saveKeys({ intercomToken, openaiKey, groqKey, chatModel, chatProvider, chatPrompt, allowedGoogleDomains, smartRetrieval, normalUserGptFallback, adminAutoFallback, fallbackProvider, fallbackModel });
      if (body.agentPassword) return res.status(400).json({ error: 'Agent password login is disabled. Agents must use Google.' });
      if (body.masterPassword) {
        if (access.authProvider !== 'google') return res.status(403).json({ error: 'Sign in with an approved Google Admin identity to change the Master password.' });
        await setMasterPassword(body.masterPassword);
        await logActivity({ actorRole: access.role, sessionId: access.sessionId, userName: access.name, userEmail: access.email, authProvider: access.authProvider, eventType: 'master_password_updated', metadata: { previousMasterSessionsRevoked: true } });
      }
      if (body.disableMasterPassword) {
        if (access.authProvider !== 'google') return res.status(403).json({ error: 'Sign in with an approved Google Admin identity to disable Master password access.' });
        await disableMasterPassword();
        await logActivity({ actorRole: access.role, sessionId: access.sessionId, userName: access.name, userEmail: access.email, authProvider: access.authProvider, eventType: 'master_password_disabled', metadata: { previousMasterSessionsRevoked: true } });
      }
      if (body.logoutAgents) await revokeAgentSessions();
      return res.status(200).json({ ok: true, ...(await fullStatus(access)) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
