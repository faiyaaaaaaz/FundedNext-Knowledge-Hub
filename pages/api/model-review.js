import {authenticateRequest,supabaseAdmin,publishScopeCatalog,getPublishedScopeCatalog,logActivity} from '../../lib/server';
export const config={maxDuration:120};
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 try{
  const user=await authenticateRequest(req);if(!user)return res.status(401).json({error:'Please sign in again.'});if(user.role!=='admin')return res.status(403).json({error:'Admin access required.'});
  const sb=supabaseAdmin();
  if(req.method==='GET'){const catalog=await getPublishedScopeCatalog(sb);const result=await sb.from('settings').select('value').eq('key','model_discovery_last_scan').maybeSingle();if(result.error)throw result.error;return res.json({catalog,scan:result.data?.value?JSON.parse(result.data.value):null});}
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const body=req.body||{};
  if(body.action==='scan'){
   const catalog=await publishScopeCatalog(sb);
   await logActivity({actorRole:user.role,userEmail:user.email,userName:user.name,sessionId:user.sessionId,eventType:'model_discovery',success:true,metadata:{articlesScanned:catalog.articlesScanned,candidates:catalog.models.filter(m=>m.status==='review').length}});
   return res.json({catalog,scan:{status:'complete',at:catalog.generatedAt,articlesScanned:catalog.articlesScanned}});
  }
  const catalog=await getPublishedScopeCatalog(sb);
  const stored=await sb.from('settings').select('value').eq('key','scope_model_overrides').maybeSingle();if(stored.error)throw stored.error;
  const overrides=stored.data?.value?JSON.parse(stored.data.value):{};
  let model=catalog.models.find(m=>m.slug===body.slug);
  if(body.action==='nominate'){
   if(!String(body.name||'').trim()||!['cfd','futures'].includes(body.product))return res.status(400).json({error:'Enter a name and product.'});
   const article=await sb.from('articles').select('intercom_id,title,body,url').eq('intercom_id',body.articleId).eq('state','published').single();if(article.error)throw new Error('Choose an existing published FAQ article ID.');
   const name=String(body.name).trim().slice(0,120),slug=body.product+'-'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
   if(catalog.models.some(m=>m.slug===slug))return res.status(400).json({error:'That candidate already exists. Review it below.'});
   model={slug,name,product:body.product,aliases:[name.toLowerCase()],articles:[{id:String(article.data.intercom_id),title:article.data.title,url:article.data.url,excerpt:String(article.data.body||'').replace(/<[^>]*>/g,' ').slice(0,800)}]};
   overrides[slug]={...model,status:'review'};
  }else{
   if(!model)return res.status(400).json({error:'Model not found. Refresh the review queue.'});
   if(body.action==='merge'){
    const target=catalog.models.find(m=>m.slug===body.target&&m.slug!==model.slug&&m.product===model.product&&['current','previous'].includes(m.status));
    if(!target)return res.status(400).json({error:'Choose an approved model in the same product family.'});
    overrides[target.slug]={...target,aliases:[...new Set([...target.aliases,...model.aliases,model.name.toLowerCase()])]};
    overrides[model.slug]={...model,status:'rejected',mergedInto:target.slug};
   }else if(body.action==='review'&&['current','previous','review','rejected'].includes(body.status)){
    overrides[model.slug]={...model,name:String(body.name||model.name).trim().slice(0,120),aliases:[...new Set([...model.aliases,String(body.name||model.name).toLowerCase()])],status:body.status};
   }else return res.status(400).json({error:'Unknown review action.'});
  }
  const save=await sb.from('settings').upsert({key:'scope_model_overrides',value:JSON.stringify(overrides)});if(save.error)throw save.error;
  const updated=await publishScopeCatalog(sb);
  await logActivity({actorRole:user.role,userEmail:user.email,userName:user.name,sessionId:user.sessionId,eventType:'model_review',success:true,metadata:{action:body.action,slug:model.slug,status:body.status,target:body.target,name:body.name}});
  return res.json({catalog:updated});
 }catch(error){return res.status(500).json({error:error.message});}
}
