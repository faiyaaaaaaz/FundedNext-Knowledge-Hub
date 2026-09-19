import { authenticateRequest, supabaseAdmin } from '../../lib/server';
import { listNotices } from '../../lib/notices';
import { buildReport } from './query-logs';
import { buildSnippetUsageReport } from './snippet-logs';
import { gzipSync } from 'zlib';

export const config = { maxDuration: 60, api: { responseLimit: false } };

// One portable diagnostic bundle. It deliberately excludes duplicate raw prompt
// payloads for ordinary high-confidence queries; the query report retains full
// diagnostic detail for failures and review candidates instead.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    const sb = supabaseAdmin();
    const [review, notices, snippetUsage] = await Promise.all([
      buildReport([], {}, true), listNotices(sb), buildSnippetUsageReport(sb)
    ]);
    const bundle = {
      schema: 'fundednext-admin-diagnostics', version: 1, exportedAt: new Date().toISOString(),
      description: 'Compact combined admin download: query evaluation, Notice knowledge, and question-level snippet-use traces.',
      summaries: { queryReview: review.counts, notices: { total: notices.length, active: notices.filter((item) => item.status === 'active').length }, snippetUsage: snippetUsage.summary },
      queryReview: review,
      noticeKnowledge: { records: notices },
      snippetUsage
    };
    const compressed = gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="fundednext-admin-diagnostics.json.gz"');
    res.setHeader('Content-Length', String(compressed.length));
    return res.status(200).send(compressed);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
