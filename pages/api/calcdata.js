import {
  authenticateRequest, listCalcData, saveCalcInstrument, saveCalcLeverage, deleteCalcLeverage
} from '../../lib/server';

// Admin-only. View and edit the calculator's instrument and leverage data.
export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    if (req.method === 'GET') return res.status(200).json(await listCalcData());

    if (req.method === 'POST') {
      const body = req.body || {};
      if (body.kind === 'instrument') await saveCalcInstrument(body);
      else if (body.kind === 'leverage') await saveCalcLeverage(body);
      else return res.status(400).json({ error: 'Unknown record type.' });
      return res.status(200).json({ ok: true, ...(await listCalcData()) });
    }

    if (req.method === 'DELETE') {
      await deleteCalcLeverage(req.body || {});
      return res.status(200).json({ ok: true, ...(await listCalcData()) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
