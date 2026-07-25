import { authenticateRequest, supabaseAdmin } from '../../lib/server';

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    const sb = supabaseAdmin();

    if (req.method === 'GET') {
      const { data, error } = await sb.from('ai_snippets').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json({ snippets: data || [] });
    }
    if (req.method === 'PATCH') {
      const { id, active, title, trigger_terms, instruction } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Snippet ID is required.' });
      const updates = { updated_at: new Date().toISOString() };
      if (typeof active === 'boolean') updates.active = active;
      if (title != null) updates.title = String(title).trim();
      if (trigger_terms != null) updates.trigger_terms = String(trigger_terms).trim();
      if (instruction != null) updates.instruction = String(instruction).trim();
      const { data, error } = await sb.from('ai_snippets').update(updates).eq('id', id).select().single();
      if (error) throw error;
      return res.status(200).json({ snippet: data });
    }
    if (req.method === 'DELETE') {
      const id = Number(req.query.id);
      const { error } = await sb.from('ai_snippets').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
