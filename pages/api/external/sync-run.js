import { authenticateExternalApiKey } from '../../../lib/externalAccess';

export const config = { maxDuration: 60 };

// Starts (or restarts) background indexing without a browser or admin session.
// It runs one pass of the same route Vercel Cron uses; that pass then keeps
// itself going while work remains. Consumes provider credits, so it needs the
// same permission as a targeted article retry.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const access = await authenticateExternalApiKey(req, 'knowledge:retry-article');
    if (!access) return res.status(401).json({ error: 'A developer API key is required.' });
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(500).json({ error: 'CRON_SECRET is not configured, so background indexing cannot start.' });
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return res.status(400).json({ error: 'Unrecognised host.' });
    let response;
    try { response = await fetch(`https://${host}/api/cron-sync`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(54000) }); }
    catch (error) { return res.status(202).json({ started: true, note: 'The pass was started but did not answer within 54s; check /api/external/sync-status.', reason: String(error?.message || error) }); }
    const body = await response.json().catch(() => ({}));
    const { sampleTitles, ...summary } = body;
    return res.status(response.status).json(summary);
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
}
