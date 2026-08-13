import { createGoogleLoginSession, logActivity } from '../../lib/server';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { googleAccessToken } = req.body || {};
    if (!googleAccessToken) return res.status(400).json({ error: 'Google sign-in is required.' });
    const session = await createGoogleLoginSession(googleAccessToken);
    await logActivity({
      actorRole: session.role,
      sessionId: session.sessionId,
      userName: session.name,
      userEmail: session.email,
      authProvider: session.authProvider,
      eventType: 'login',
      metadata: { userAgent: String(req.headers['user-agent'] || '').slice(0, 300) }
    });
    return res.status(200).json(session);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
