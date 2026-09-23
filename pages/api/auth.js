import { createGoogleLoginSession, createMasterLoginSession, logActivity } from '../../lib/server';

function masterCookie(token, maxAge) {
  const production = process.env.NODE_ENV === 'production';
  const name = production ? '__Host-fn_master_session' : 'fn_master_session';
  const expiry = maxAge === 0 ? '; Max-Age=0' : '';
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict${expiry}${production ? '; Secure' : ''}`;
}

function clearMasterCookies() {
  return [
    '__Host-fn_master_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure',
    'fn_master_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
  ];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { googleAccessToken, masterPassword, logout } = req.body || {};
    if (logout) {
      res.setHeader('Set-Cookie', clearMasterCookies());
      return res.status(200).json({ ok: true });
    }
    let session;
    if (googleAccessToken) {
      session = await createGoogleLoginSession(googleAccessToken);
      // Do not let a stale Master cookie shadow the newly selected Google role.
      res.setHeader('Set-Cookie', clearMasterCookies());
    } else if (masterPassword) {
      session = await createMasterLoginSession(masterPassword, req);
      if (!session) return res.status(401).json({ error: 'The Master password was not accepted.' });
      res.setHeader('Set-Cookie', masterCookie(session.token, session.expiresIn));
    } else {
      return res.status(400).json({ error: 'Choose Google sign-in or enter the Master password.' });
    }
    await logActivity({
      actorRole: session.role,
      sessionId: session.sessionId,
      userName: session.name,
      userEmail: session.email,
      authProvider: session.authProvider,
      eventType: 'login',
      metadata: { userAgent: String(req.headers['user-agent'] || '').slice(0, 300) }
    });
    return res.status(200).json(session.authProvider === 'master_password' ? { ...session, token: 'master-cookie' } : session);
  } catch (e) {
    return res.status(e.statusCode || 500).json({ error: e.message });
  }
}
