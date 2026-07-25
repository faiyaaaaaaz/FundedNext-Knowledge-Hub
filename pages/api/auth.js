import { createLoginSession, createGoogleLoginSession, logActivity } from '../../lib/server';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { password, googleAccessToken } = req.body || {};
    if (!password && !googleAccessToken) return res.status(400).json({ error: 'Choose Google sign-in or enter the Admin password.' });
    const session = googleAccessToken
      ? await createGoogleLoginSession(googleAccessToken)
      : await createLoginSession(password);
    if (!session) return res.status(401).json({ error: 'That password is not correct.' });
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
