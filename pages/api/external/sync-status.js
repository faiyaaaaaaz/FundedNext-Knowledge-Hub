import { authenticateExternalApiKey } from '../../../lib/externalAccess';
import { getKeys, supabaseAdmin } from '../../../lib/server';
import { faqImages, unsupportedFaqImages, keyFingerprint } from '../../../lib/faqImageText.mjs';

export const config = { maxDuration: 60 };

const json = (value, fallback) => { try { return JSON.parse(value || ''); } catch { return fallback; } };
const failureClass = (error = '') =>
  /\b429\b|exhaust|quota|rate.?limit|resting/i.test(error) ? 'quota' :
  /all configured/i.test(error) ? 'all-keys-unavailable' :
  /could not be verified|Unverified FAQ images/i.test(error) ? 'verification' :
  /timed out|too long|temporar/i.test(error) ? 'timeout' :
  /too large/i.test(error) ? 'image-too-large' :
  /more than/i.test(error) ? 'too-many-images' :
  /host is not trusted/i.test(error) ? 'untrusted-host' : 'other';

// Read-only view of FAQ image indexing: worker heartbeat, pause, per-key rest
// state, recent vision calls, and the saved checkpoint of every queued article.
// Never returns article bodies, provider keys, or personal data.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const access = await authenticateExternalApiKey(req, 'diagnostics:read');
    if (!access) return res.status(401).json({ error: 'A developer API key is required.' });
    const sb = supabaseAdmin();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
    const [queue, total, settings, keys] = await Promise.all([
      sb.from('articles').select('intercom_id,title,body').eq('needs_index', true).limit(400),
      sb.from('articles').select('intercom_id', { count: 'exact', head: true }).eq('needs_index', true),
      sb.from('settings').select('key,value').in('key', ['sync_heartbeat_v1', 'faq_image_quota_cooldown_until', 'faq_image_key_cooldowns_v1', 'faq_image_events_v1', 'faq_image_failures_v1']),
      getKeys()
    ]);
    for (const result of [queue, total, settings]) if (result.error) throw new Error(result.error.message);
    const values = Object.fromEntries(settings.data.map(row => [row.key, row.value]));
    const failures = json(values.faq_image_failures_v1, {});
    const rested = json(values.faq_image_key_cooldowns_v1, {});
    const events = json(values.faq_image_events_v1, {}).events || [];
    const heartbeat = json(values.sync_heartbeat_v1, {});
    const rows = queue.data || [];
    const ids = rows.map(row => 'faq_image_stage_' + row.intercom_id);
    const stages = ids.length ? await sb.from('settings').select('key,value').in('key', ids) : { data: [] };
    if (stages.error) throw new Error(stages.error.message);
    const stageById = Object.fromEntries((stages.data || []).map(row => [row.key.replace('faq_image_stage_', ''), json(row.value, {})]));
    const now = Date.now();
    const articles = rows.map(row => {
      const id = String(row.intercom_id), images = faqImages(row.body).length, stage = stageById[id] || {};
      const saved = (stage.texts || []).filter(Boolean).length, rejected = (stage.texts || []).filter(item => item === null).length;
      const failure = failures[id];
      return { id, title: String(row.title || '').slice(0, 90), images, unsupportedImages: unsupportedFaqImages(row.body).length, savedReadings: saved, rejectedReadings: rejected,
        failure: failure ? { class: failureClass(failure.error), at: failure.failedAt, retryAfter: failure.retryAfter } : null };
    });
    const withImages = articles.filter(item => item.images > 0);
    const cooldownUntil = values.faq_image_quota_cooldown_until || null;
    const lastBeat = heartbeat.last || null;
    const beatAge = lastBeat?.startedAt ? now - Date.parse(lastBeat.finishedAt || lastBeat.startedAt) : null;
    const timed = events.filter(event => event.ok && Number.isFinite(event.ms)).map(event => event.ms).sort((a, b) => a - b);
    const counts = (list) => list.reduce((acc, item) => { acc[item] = (acc[item] || 0) + 1; return acc; }, {});
    return res.json({
      generatedAt: new Date(now).toISOString(),
      queue: { queued: total.count ?? rows.length, inspected: rows.length, withImages: withImages.length, withoutImages: articles.length - withImages.length,
        totalImages: withImages.reduce((sum, item) => sum + item.images, 0), savedReadings: articles.reduce((sum, item) => sum + item.savedReadings, 0),
        articlesWithAnyCheckpoint: articles.filter(item => item.savedReadings > 0).length },
      worker: {
        state: !lastBeat ? 'no-heartbeat-yet' : !lastBeat.finishedAt ? (beatAge < 120000 ? 'running' : 'interrupted-or-expired') : beatAge < 120000 ? 'active-recently' : 'idle',
        last: lastBeat, lockedAt: heartbeat.lockedAt || null, lockedCount: heartbeat.lockedCount || 0,
        note: 'The 120-second database lease is not readable from this route; running/interrupted is inferred from the heartbeat.'
      },
      pause: { cooldownUntil, active: !!cooldownUntil && Date.parse(cooldownUntil) > now, secondsRemaining: cooldownUntil ? Math.max(0, Math.round((Date.parse(cooldownUntil) - now) / 1000)) : 0 },
      keys: (keys.geminiKeyPool || []).map(item => {
        const fingerprint = keyFingerprint(item.key), state = rested[fingerprint];
        return { name: item.name, fingerprint, resting: !!state && state.until > now, restingUntil: state && state.until > now ? new Date(state.until).toISOString() : null, strikes: state?.strikes || 0, lastStatus: state?.status ?? null };
      }),
      model: { chatProvider: keys.chatProvider, chatModel: keys.chatModel, embeddingProvider: keys.embeddingProvider },
      recentVisionCalls: { count: events.length, ok: events.filter(event => event.ok).length, byStatus: counts(events.filter(event => !event.ok).map(event => String(event.status || 'error'))),
        medianMsOk: timed.length ? timed[Math.floor(timed.length / 2)] : null, p90MsOk: timed.length ? timed[Math.floor(timed.length * 0.9)] : null,
        distinctKeysUsed: new Set(events.map(event => event.key)).size, last: events.slice(-15) },
      failureLedger: { entries: Object.keys(failures).length, byClass: counts(Object.values(failures).map(item => failureClass(item.error))) },
      articles: articles.sort((a, b) => b.images - a.images).slice(0, limit)
    });
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
}
