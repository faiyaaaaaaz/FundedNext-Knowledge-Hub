import { createLoginSession } from '../../lib/server';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Enter your password.' });
    const session = await createLoginSession(password);
    if (!session) return res.status(401).json({ error: 'That password is not correct.' });
    return res.status(200).json(session);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
