import { authenticateRequest, logActivity, MASTER_PRINCIPAL, supabaseAdmin } from '../../lib/server';

const TOUR_VERSION = 'workspace-tour-2026-09-v3';
function checked(result) { if (result.error) throw result.error; return result.data; }
function tourStatus(person) {
  if (!person?.scope_tour_at) return 'Not started';
  if (!person?.answer_tour_at) return 'Scope guide completed';
  return 'Completed';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await authenticateRequest(req);
    if (!user) return res.status(401).json({ error: 'Please sign in again.' });
    // Master-password sessions do not have a Google profile. Keep this endpoint
    // defensive as well as relying on authenticateRequest's legacy-cookie upgrade.
    const email = String(user.email || (user.authProvider === 'master_password' ? MASTER_PRINCIPAL : '')).trim().toLowerCase();
    if (!email) return res.status(401).json({ error: 'Your account identity is unavailable. Please sign in again.' });
    const sb = supabaseAdmin();
    const action = req.query.action || req.body?.action || 'inbox';
    checked(await sb.from('workspace_people').upsert({ email, name: user.name }, { onConflict: 'email' }));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    if (req.method === 'GET') {
      if (action === 'history') {
        const rows = checked(await sb.from('activity_logs').select('id,created_at,metadata,success,provider').eq('user_email', email).eq('event_type', 'query').order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 29));
        return res.json({ items: rows.map(r => ({ id: r.id, created_at: r.created_at, question: r.metadata?.question || r.metadata?.questionPreview || '', answer: r.metadata?.answer || r.metadata?.answerPreview || r.metadata?.error || 'No completed answer was recorded.', sources: r.metadata?.sources || [], feedback: r.metadata?.feedback, confidence: r.metadata?.confidence, confidenceLabel: r.metadata?.confidenceLabel || '', provider: r.provider, scope: { product: r.metadata?.selectedProduct, model: r.metadata?.selectedModel, label: r.metadata?.selectedScopeLabel }, incomplete: !r.metadata?.answer, success: r.success })), more: rows.length === 30 });
      }
      if (action === 'disputes') {
        const items = checked(await sb.from('disputes').select('id,created_at,question,answer,dispute_reason,status,approval_reason,reviewed_at').eq('user_email', email).order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 29));
        return res.json({ items, more: items.length === 30 });
      }
      if (action === 'tour') {
        const person = checked(await sb.from('workspace_people').select('scope_tour_at,answer_tour_at').eq('email', email).single());
        return res.json({ person, tourVersion: TOUR_VERSION, status: tourStatus(person) });
      }
      if (action === 'tour-report') {
        if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
        const [peopleResult, completionsResult] = await Promise.all([
          sb.from('workspace_people').select('email,name,scope_tour_at,answer_tour_at').order('email'),
          sb.from('activity_logs').select('user_email,created_at,metadata').eq('event_type', 'workspace_tour_completed').order('created_at', { ascending: false }).limit(5000)
        ]);
        if (peopleResult.error) throw peopleResult.error;
        if (completionsResult.error) throw completionsResult.error;
        const completionByEmail = new Map();
        for (const event of completionsResult.data || []) {
          if (!event.user_email || completionByEmail.has(event.user_email)) continue;
          completionByEmail.set(event.user_email, event);
        }
        const people = (peopleResult.data || []).map(person => {
          const completion = completionByEmail.get(person.email);
          return { ...person, status: tourStatus(person), recordedVersion: completion?.metadata?.tourVersion || (person.scope_tour_at || person.answer_tour_at ? 'legacy-unversioned' : null), lastTourEventAt: completion?.created_at || null };
        });
        return res.json({ tourVersion: TOUR_VERSION, people, summary: { registered: people.length, completed: people.filter(p => p.status === 'Completed').length, notStarted: people.filter(p => p.status === 'Not started').length, scopeOnly: people.filter(p => p.status === 'Scope guide completed').length } });
      }
      if (action === 'sent' || action === 'report') {
        if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
        const query = action === 'sent' ? sb.from('workspace_messages').select('*').order('created_at', { ascending: false }) : sb.from('workspace_notifications').select('id,recipient,created_at,read_at').eq('message_id', req.query.id).order('recipient');
        const items = checked(await query.range(offset, offset + 29));
        return res.json({ items, more: items.length === 30 });
      }
      if (action !== 'inbox') return res.status(400).json({ error: 'Unknown action.' });
      const items = checked(await sb.from('workspace_notifications').select('*').eq('recipient', email).order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 29));
      const count = await sb.from('workspace_notifications').select('id', { count: 'exact', head: true }).eq('recipient', email).is('read_at', null);
      if (count.error) throw count.error;
      return res.json({ items, unread: count.count, more: items.length === 30 });
    }
    if (req.method === 'POST') {
      if (action === 'read') return res.json({ readAt: checked(await sb.rpc('workspace_read', { p_id: req.body.id, p_email: email })) });
      if (action === 'tour') {
        const field = req.body.stage === 'scope' ? 'scope_tour_at' : req.body.stage === 'answer' ? 'answer_tour_at' : null;
        if (!field) return res.status(400).json({ error: 'Invalid tour stage.' });
        const completedAt = new Date().toISOString();
        checked(await sb.from('workspace_people').update({ [field]: completedAt }).eq('email', email).is(field, null));
        await logActivity({ actorRole: user.role, sessionId: user.sessionId, userName: user.name, userEmail: email, authProvider: user.authProvider, eventType: 'workspace_tour_completed', success: true, metadata: { stage: req.body.stage, tourVersion: TOUR_VERSION, completedAt } });
        return res.json({ ok: true, tourVersion: TOUR_VERSION });
      }
      if (action === 'tour-reset-all') {
        if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
        const resetAt = new Date().toISOString();
        const reset = await sb.from('workspace_people').update({ scope_tour_at: null, answer_tour_at: null }).not('email', 'is', null).select('email');
        if (reset.error) throw reset.error;
        await logActivity({ actorRole: user.role, sessionId: user.sessionId, userName: user.name, userEmail: email, authProvider: user.authProvider, eventType: 'workspace_tour_reset_all', success: true, metadata: { tourVersion: TOUR_VERSION, resetAt, usersReset: (reset.data || []).length } });
        return res.json({ ok: true, usersReset: (reset.data || []).length, tourVersion: TOUR_VERSION });
      }
      if (action === 'send') {
        if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
        const title = String(req.body.title || '').trim(), body = String(req.body.body || '').trim(), audience = String(req.body.audience || '').trim().toLowerCase();
        if (!title || title.length > 160 || !body || body.length > 12000 || !(audience === 'all' || /^[^\s@]+@nextventures\.io$/.test(audience)) || !/^[0-9a-f-]{36}$/i.test(req.body.id || '')) return res.status(400).json({ error: 'Enter a title, message, and valid recipient (or all).' });
        return res.json({ id: checked(await sb.rpc('workspace_send', { p_id: req.body.id, p_sender: email, p_audience: audience, p_title: title, p_body: body })) });
      }
    }
    return res.status(405).json({ error: 'Unsupported request.' });
  } catch (error) { return res.status(500).json({ error: error.message }); }
}
