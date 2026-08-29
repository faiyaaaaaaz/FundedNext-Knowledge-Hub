import { authenticateRequest, logActivity, supabaseAdmin } from '../../lib/server';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  const access = await authenticateRequest(req);
  if (!access) return res.status(401).json({ error: 'Your session ended. Please sign in again.' });

  const queryLogId = String(req.body?.queryLogId || '').trim();
  const rating = String(req.body?.rating || '').trim().toLowerCase();
  if (!queryLogId || !['helpful', 'great'].includes(rating)) {
    return res.status(400).json({ error: 'A valid answer and feedback choice are required.' });
  }

  const db = supabaseAdmin();
  const { data: query, error } = await db.from('activity_logs')
    .select('id,user_email,event_type,metadata').eq('id', queryLogId).maybeSingle();
  if (error || !query || query.event_type !== 'query') return res.status(404).json({ error: 'That answer log could not be found.' });
  if (access.role !== 'admin' && String(query.user_email || '').toLowerCase() !== String(access.email || '').toLowerCase()) {
    return res.status(403).json({ error: 'You can only rate your own answer.' });
  }

  const feedbackAt = new Date().toISOString();
  const metadata = { ...(query.metadata || {}), feedback: rating, feedbackAt, feedbackBy: access.email || access.name || 'Agent' };
  const { error: updateError } = await db.from('activity_logs').update({ metadata }).eq('id', queryLogId);
  if (updateError) return res.status(500).json({ error: 'Feedback could not be saved.' });

  await logActivity({
    actorRole: access.role, sessionId: access.sessionId, userName: access.name,
    userEmail: access.email, authProvider: access.authProvider,
    eventType: 'answer_feedback', metadata: { queryLogId, rating }
  });
  return res.status(200).json({ ok: true, rating });
}
