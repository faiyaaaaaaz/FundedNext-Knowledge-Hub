import { authenticateRequest, getKeys, supabaseAdmin, syncStep } from '../../lib/server';

export const config = { maxDuration: 60 };

// Manual sync used by the Admin "Check for updates" console. The client calls
// this repeatedly until `done` is true, showing progress after each call.
// The heavy lifting lives in syncStep() so this route and the automatic
// /api/cron-sync route stay perfectly in step.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    const { intercomToken, openaiKey } = await getKeys();
    if (!intercomToken) return res.status(400).json({ error: 'No Intercom key saved yet. Add it in Admin first.' });
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key saved yet. Add it in Admin first.' });

    const result = await syncStep(supabaseAdmin(), { intercomToken, openaiKey });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
