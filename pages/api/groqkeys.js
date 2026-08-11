import {
  authenticateRequest, listGroqKeys, addGroqKey, setGroqKeyActive, deleteGroqKey
} from '../../lib/server';

// Admin-only. Manage the pool of Groq API keys the app rotates over.
export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    if (req.method === 'GET') return res.status(200).json({ keys: await listGroqKeys() });

    if (req.method === 'POST') {
      const { label, key, id, active } = req.body || {};
      if (id != null && typeof active === 'boolean') await setGroqKeyActive(id, active);
      else await addGroqKey({ label, key });
      return res.status(200).json({ ok: true, keys: await listGroqKeys() });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id || (req.body && req.body.id);
      if (!id) return res.status(400).json({ error: 'Missing key id.' });
      await deleteGroqKey(id);
      return res.status(200).json({ ok: true, keys: await listGroqKeys() });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
