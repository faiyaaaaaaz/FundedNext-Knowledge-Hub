import { authenticateRequest, supabaseAdmin } from '../../lib/server';

function checked(result) { if (result.error) throw result.error; return result.data; }
export default async function handler(req, res) {
 res.setHeader('Cache-Control','no-store');
 try {
  const user = await authenticateRequest(req);
  if (!user) return res.status(401).json({error:'Please sign in again.'});
  const sb = supabaseAdmin(), email = user.email.toLowerCase();
  const action = req.query.action || req.body?.action || 'inbox';
  checked(await sb.from('workspace_people').upsert({email,name:user.name},{onConflict:'email'}));
  const offset = Math.max(0,parseInt(req.query.offset,10)||0);
  if (req.method === 'GET') {
   if (action === 'history') {
    const rows = checked(await sb.from('activity_logs').select('id,created_at,metadata,success,provider').eq('user_email',email).eq('event_type','query').order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+29));
    return res.json({items:rows.map(r=>({id:r.id,created_at:r.created_at,question:r.metadata?.question||r.metadata?.questionPreview||'',answer:r.metadata?.answer||r.metadata?.answerPreview||r.metadata?.error||'No completed answer was recorded.',sources:r.metadata?.sources||[],feedback:r.metadata?.feedback,confidence:r.metadata?.confidence,provider:r.provider,scope:{product:r.metadata?.selectedProduct,model:r.metadata?.selectedModel,label:r.metadata?.selectedScopeLabel},incomplete:!r.metadata?.answer,success:r.success})),more:rows.length===30});
   }
   if (action === 'disputes') {
    const items = checked(await sb.from('disputes').select('id,created_at,question,answer,dispute_reason,status,approval_reason,reviewed_at').eq('user_email',email).order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+29));
    return res.json({items,more:items.length===30});
   }
   if (action === 'tour') return res.json({person:checked(await sb.from('workspace_people').select('scope_tour_at,answer_tour_at').eq('email',email).single())});
   if (action === 'sent' || action === 'report') {
    if(user.role!=='admin') return res.status(403).json({error:'Admin access required.'});
    const query=action==='sent'?sb.from('workspace_messages').select('*').order('created_at',{ascending:false}):sb.from('workspace_notifications').select('id,recipient,created_at,read_at').eq('message_id',req.query.id).order('recipient');
    const items=checked(await query.range(offset,offset+29));
    return res.json({items,more:items.length===30});
   }
   if(action!=='inbox') return res.status(400).json({error:'Unknown action.'});
   const items=checked(await sb.from('workspace_notifications').select('*').eq('recipient',email).order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+29));
   const count=await sb.from('workspace_notifications').select('id',{count:'exact',head:true}).eq('recipient',email).is('read_at',null);
   if(count.error) throw count.error;
   return res.json({items,unread:count.count,more:items.length===30});
  }
  if (req.method === 'POST') {
   if(action==='read') return res.json({readAt:checked(await sb.rpc('workspace_read',{p_id:req.body.id,p_email:email}))});
   if(action==='tour') {
    const field=req.body.stage==='scope'?'scope_tour_at':req.body.stage==='answer'?'answer_tour_at':null;
    if(!field) return res.status(400).json({error:'Invalid tour stage.'});
    checked(await sb.from('workspace_people').update({[field]:new Date().toISOString()}).eq('email',email).is(field,null));
    return res.json({ok:true});
   }
   if(action==='send') {
    if(user.role!=='admin') return res.status(403).json({error:'Admin access required.'});
    const title=String(req.body.title||'').trim(), body=String(req.body.body||'').trim(), audience=String(req.body.audience||'').trim().toLowerCase();
    if(!title||title.length>160||!body||body.length>12000||!(audience==='all'||/^[^\s@]+@nextventures\.io$/.test(audience))||!/^[0-9a-f-]{36}$/i.test(req.body.id||'')) return res.status(400).json({error:'Enter a title, message, and valid recipient (or all).'});
    return res.json({id:checked(await sb.rpc('workspace_send',{p_id:req.body.id,p_sender:email,p_audience:audience,p_title:title,p_body:body}))});
   }
  }
  return res.status(405).json({error:'Unsupported request.'});
 } catch(error) { return res.status(500).json({error:error.message}); }
}
