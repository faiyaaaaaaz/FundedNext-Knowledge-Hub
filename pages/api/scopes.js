import crypto from 'crypto';
import { authenticateRequest, getPublishedScopeCatalog, supabaseAdmin } from '../../lib/server';

function preferenceKey(email) {
  const digest = crypto.createHash('sha256').update(String(email || '').toLowerCase()).digest('hex').slice(0, 24);
  return `scope_preference_${digest}`;
}

function safePreference(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return {
      product: ['cfd', 'futures', 'both'].includes(parsed?.product) ? parsed.product : 'cfd',
      model: String(parsed?.model || 'all').slice(0, 120)
    };
  } catch { return { product: 'cfd', model: 'all' }; }
}

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    const sb = supabaseAdmin();
    const key = preferenceKey(access.email);

    if (req.method === 'GET') {
      const [catalog, prefResult] = await Promise.all([
        getPublishedScopeCatalog(sb),
        sb.from('settings').select('value').eq('key', key).maybeSingle()
      ]);
      const preference = safePreference(prefResult.data?.value);
      const selectedExists = preference.model === 'all' || catalog.models.some((model) =>
        model.slug === preference.model && (preference.product === 'both' || model.product === preference.product)
      );
      return res.status(200).json({ catalog, preference, selectedExists });
    }

    if (req.method === 'POST') {
      const preference = safePreference(req.body || {});
      const catalog = await getPublishedScopeCatalog(sb);
      const valid = preference.model === 'all' || catalog.models.some((model) =>
        model.slug === preference.model && model.status !== 'review' && (preference.product === 'both' || model.product === preference.product)
      );
      if (!valid) return res.status(400).json({ error: 'That Account model is not available in the verified catalogue.' });
      const { error } = await sb.from('settings').upsert({ key, value: JSON.stringify(preference) });
      if (error) throw new Error('Could not save your scope preference: ' + error.message);
      return res.status(200).json({ ok: true, preference });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
