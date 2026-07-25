import { authenticateRequest, supabaseAdmin } from '../../lib/server';

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    const sb = supabaseAdmin();

    if (req.method === 'GET') {
      const { data, error } = await sb.from('branding_terms').select('*').order('category').order('required_term');
      if (error) throw error;
      return res.status(200).json({ terms: data || [] });
    }

    if (req.method === 'POST') {
      const term = req.body || {};
      if (!String(term.required_term || '').trim()) return res.status(400).json({ error: 'Required wording cannot be blank.' });
      if (!['exact', 'replacement', 'context'].includes(term.rule_type)) return res.status(400).json({ error: 'Choose a valid rule type.' });
      if (term.rule_type === 'replacement' && !String(term.match_term || '').trim()) return res.status(400).json({ error: 'Replacement rules need prohibited wording.' });
      const row = {
        category: String(term.category || 'General').trim(),
        rule_type: term.rule_type,
        match_term: String(term.match_term || '').trim() || null,
        required_term: String(term.required_term).trim(),
        notes: String(term.notes || '').trim() || null,
        active: term.active !== false,
        updated_at: new Date().toISOString()
      };
      const query = term.id
        ? sb.from('branding_terms').update(row).eq('id', term.id).select().single()
        : sb.from('branding_terms').insert(row).select().single();
      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json({ term: data });
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query.id);
      if (!id) return res.status(400).json({ error: 'A term ID is required.' });
      const { error } = await sb.from('branding_terms').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
