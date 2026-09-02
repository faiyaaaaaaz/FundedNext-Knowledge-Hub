// ============================================================================
// pages/api/notices.js
// Admin API for the Notices layer. Gated to allowlisted emails only.
// Actions: import (upload RAG), reconcile, reindex, set-status, save-entry.
// ============================================================================
import { authenticateRequest, supabaseAdmin, getKeys } from '../../lib/server';
import {
  isNoticeLabUser, importNoticesRag, reconcileNotices, reindexNotices,
  listNotices, setNoticeStatus, saveNoticeEntry
} from '../../lib/notices';

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (!(await isNoticeLabUser(access))) return res.status(403).json({ error: 'Notices admin is not enabled for your account.' });

    const sb = supabaseAdmin();

    if (req.method === 'GET') {
      return res.status(200).json({ notices: await listNotices(sb) });
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      if (body.action === 'import') {
        const rag = typeof body.rag === 'string' ? JSON.parse(body.rag) : body.rag;
        const imp = await importNoticesRag(rag, sb);
        const rec = await reconcileNotices(sb);
        const { openaiKey } = await getKeys();
        const idx = await reindexNotices(sb, { openaiKey });
        return res.status(200).json({ ok: true, imported: imp.imported, reconciled: rec.updated, indexed: idx.indexed });
      }

      if (body.action === 'reconcile') {
        return res.status(200).json({ ok: true, ...(await reconcileNotices(sb)) });
      }

      if (body.action === 'reindex') {
        const { openaiKey } = await getKeys();
        return res.status(200).json({ ok: true, ...(await reindexNotices(sb, { openaiKey })) });
      }

      if (body.action === 'set-status') {
        await setNoticeStatus(body.entry_id, body.status, sb);
        const { openaiKey } = await getKeys();
        await reindexNotices(sb, { openaiKey });
        return res.status(200).json({ ok: true });
      }

      if (body.action === 'save-entry') {
        await saveNoticeEntry(body.entry, sb);
        await reconcileNotices(sb);
        const { openaiKey } = await getKeys();
        await reindexNotices(sb, { openaiKey });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Unknown action.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
