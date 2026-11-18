import { authenticateExternalApiKey } from '../../../lib/externalAccess';
import { getKeys, supabaseAdmin, syncStep, withSyncLease } from '../../../lib/server';
import { faqImages, unsupportedFaqImages } from '../../../lib/faqImageText.mjs';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET','POST'].includes(req.method)) return res.status(405).end();
  try {
    const retry = req.method === 'POST';
    const access = await authenticateExternalApiKey(req, retry ? 'knowledge:retry-article' : 'knowledge:read-metadata');
    if (!access) return res.status(401).json({error:'Developer key required.'});
    const articleId = String((retry ? req.body : req.query)?.articleId || '');
    if (!/^\d{1,25}$/.test(articleId)) return res.status(400).json({error:'One numeric articleId is required.'});
    const sb = supabaseAdmin();
    if (retry) {
      const result = await withSyncLease(sb, 'manual', async () => syncStep(sb, await getKeys(), {articleId}));
      return res.status(result.locked ? 409 : 200).json({articleId, ...result, articleComplete:result.processed === 1});
    }
    const [article, chunks, settings] = await Promise.all([
      sb.from('articles').select('title,body,needs_index,last_indexed_at').eq('intercom_id',articleId).eq('state','published').maybeSingle(),
      sb.from('chunks').select('chunk_index,content').eq('article_id',articleId).order('chunk_index').limit(200),
      sb.from('settings').select('key,value').in('key',['faq_image_failures_v1','faq_image_quota_cooldown_until','faq_image_stage_'+articleId])
    ]);
    for (const result of [article,chunks,settings]) if (result.error) throw new Error(result.error.message);
    if (!article.data) return res.status(404).json({error:'Published FAQ not found.'});
    const {body,...details} = article.data;
    const values = Object.fromEntries(settings.data.map(row => [row.key,row.value]));
    return res.json({articleId,...details, eligibleImages:faqImages(body).length, unsupportedImages:unsupportedFaqImages(body).length,
      savedImageReadings:JSON.parse(values['faq_image_stage_'+articleId] || '{}').texts?.length || 0,
      cooldownUntil:values.faq_image_quota_cooldown_until || null, lastImageFailure:JSON.parse(values.faq_image_failures_v1 || '{}')[articleId] || null,
      passages:chunks.data.map(row=>({index:row.chunk_index,text:row.content}))});
  } catch(error) {return res.status(error.status || 500).json({error:error.message});}
}
