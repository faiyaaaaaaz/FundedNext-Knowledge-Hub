// Candidate discovery is advisory. Preserve compound names; never infer that
// translated copies or repeated policy words prove a model exists.
export function normalizeModelName(value) {
 return String(value||'').replace(/^(?:(?:at|and|both|for|the|my|your|our|new|what|is|are|does|how|can|a|an)\s+)+/i,'')
 .replace(/^FundedNext\s+/i,'').replace(/^Futures\s+/i,'').trim().toLowerCase().replace(/[^a-z0-9&]+/g,' ').trim();
}
export function discoverModels(articles,known=[]) {
 const candidates=new Map();
 const generic=/^(?:available|current|close|closed|daily|both|and|at|cfd|futures|fnmarkets|fundednext|free|a free|free trial|standard|trading|live|demo|funded|account|challenge|model|new|this)$/i;
 for(const article of articles){
  let sourceProduct;try{const host=new URL(article.url).hostname;sourceProduct=host==='help.fnmarkets.com'?'fnmarkets':host==='help.fundednext.com'?(/\bfn\s*markets\b/i.test(String(article.title||''))?'fnmarkets':'cfd'):host==='helpfutures.fundednext.com'?'futures':null;}catch{continue;}
  if(!sourceProduct)continue;
  const title=String(article.title||'').replace(/^\[[^\]]+\]\s*/,'');
  // A CFD help-centre article can document a Futures product. Use its title
  // when explicitly branded; mentions in the body alone do not reclassify it.
  if(sourceProduct==='cfd' && /\b(?:FundedNext\s+)?Futures\s+(?!Labs?\b)[A-Z][\w-]*(?:\s+[A-Z][\w-]*)*\b/i.test(title) && !/\bFNL\s*:?\s*\d+/i.test(title)) sourceProduct='futures';
  const text=title+'\n'+String(article.body||'').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|amp);/g,m=>m==='&amp;'?'&':' ').replace(/[–—]/g,'-');
  const patterns=[
   /\b(Stellar\s+[A-Z0-9][A-Za-z0-9-]*(?:\s+(?:Pro|Plus|Instant|Lite|1-Step|2-Step))?)\b/g,
   /\b(FNL\s*:?\s*\d{3,})\b/gi,
   /\b(?:FundedNext\s+)?Futures\s+([A-Z][\w-]*(?:\s+(?:[A-Z][\w-]*|&)){0,4})\s+(?:Account|Challenge|Model)\b/g,
   /\b([A-Z][\w-]*(?:\s+(?:[A-Z0-9][\w-]*|&)){0,4})\s+(?:Account|Challenge|Model)\b/g
  ];
  for(const pattern of patterns)for(const match of text.matchAll(pattern)){
   let name=match[1].replace(/^(?:(?:At|And|Both|For|The|My|Your|Our|New|What|Is|Are|Does|How|Can|A|An)\s+)+/g,'').replace(/^FundedNext\s+/,'').trim();
   if(/^(?:Account|Challenge|Model)$/.test(name))continue;
   name=name.replace(/\s+FundedNext$/,'');
   const key=normalizeModelName(name),compound=/&/.test(name);
   const explicitDaily=key==='daily'&&/\bFutures\s+Daily\s+(?:Account|Challenge|Model)\b/.test(match[0]);
   if(!key||(!compound&&generic.test(key)&&!explicitDaily))continue;
   if(/\b(?:rules?|loss|profit|drawdown|payout|kyc|leverage|minimum|maximum|reward|account|challenge|requirements?|balance|payment)\b/i.test(name))continue;
   // A known name mentioned in the other help centre is evidence of a
   // cross-product mention, not a new model in that centre.
   if(known.some(m=>[m.name,...(m.aliases||[])].some(a=>normalizeModelName(a)===key)))continue;
   const location=match.index<title.length?'title':'article text';
   // Unbranded single words in body prose are too weak. Keep such names only
   // in clear introductory titles, not policy phrases such as "Daily Account".
   if(!/\s|:|\d/.test(name)&&location!=='title')continue;
   if(!/\s|:|\d/.test(name)&&!/\b(?:what is|introducing|introduce|called|named)\b/i.test(title))continue;
   // FNmarkets campaign articles can mention a FundedNext Stellar challenge.
   // That cross-product mention must not create a CFD model inside the
   // brokerage catalogue.
   const product=sourceProduct==='fnmarkets'?'fnmarkets':/^Stellar\b/i.test(name)?'cfd':/^Futures\b/i.test(match[0]) && !/^FNL\b/i.test(name)?'futures':sourceProduct;
   const display=product==='futures'&&!/^FNL\b/i.test(name)&&!/^Futures\b/.test(name)?'Futures '+name:name;
   const id=product+':'+key;
   const candidate=candidates.get(id)||{slug:product+'-'+key.replace(/[^a-z0-9]+/g,'-'),product,name:display,status:'review',aliases:[display.toLowerCase(),...( /^FNL\s*:?\s*\d+$/i.test(display) ? [display.toLowerCase().replace(/\s*:\s*/, ' '),display.toLowerCase().replace(/[^a-z0-9]/g,'')] : [])],articles:[],articleCount:0,autoDetected:true,reviewNote:compound?'Compound title: verify whether this is one model, several models, or a programme. Do not approve a shortened fragment.':'Verify the full model name and product against the source.'};
   if(!candidate.articles.some(a=>a.id===String(article.intercom_id))){candidate.articleCount++;candidate.articles.push({id:String(article.intercom_id),title:article.title,url:article.url,sourceProduct,excerpt:text.slice(Math.max(0,match.index-100),match.index+match[0].length+180),location});}
   candidates.set(id,candidate);
  }
 }
 return [...candidates.values()].map(c=>({...c,articles:c.articles.slice(0,80)}));
}
export function applyModelOverrides(catalogue,overrides={}) {
 const models=new Map(catalogue.map(m=>[m.slug,{...m,articles:[...(m.articles||[])]}]));
 for(const [slug,o] of Object.entries(overrides)){
  if(!models.has(slug)&&(!o.name||!o.product))continue;
  const base=models.get(slug)||{slug,articles:[],articleCount:0,aliases:[]};
  const articles=[...new Map([...(base.articles||[]),...(o.articles||[])].map(a=>[String(a.id),a])).values()];
  models.set(slug,{...base,...o,slug,articles:articles.slice(0,80),articleCount:Math.max(base.articleCount||0,articles.length),adminConfirmed:true});
 }
 for(const model of models.values()){
  if(!model.mergedInto)continue;
  const target=models.get(model.mergedInto);if(!target)continue;
  const articles=[...new Map([...(target.articles||[]),...(model.articles||[])].map(a=>[String(a.id),a])).values()];
  target.articles=articles.slice(0,80);target.articleCount=Math.max(target.articleCount||0,articles.length);
 }
 return [...models.values()];
}

// Notices explicitly identify a product and model. Published active notices
// make a model searchable, but do not prove that it is still sold.
export function discoverNoticeModels(notices, known = [], now = Date.now()) {
 const found = new Map();
 for (const n of notices || []) {
  if (n.status !== 'active' || n.review_flag || !['cfd','futures','fnmarkets'].includes(n.product)) continue;
  if (n.effective_from && Date.parse(n.effective_from) > now) continue;
  if (n.effective_until && Date.parse(n.effective_until) <= now) continue;
  const raw = String(n.model || '').trim().toLowerCase();
  if (!raw || raw === 'all' || !/^[a-z0-9][a-z0-9_-]{1,79}$/.test(raw)) continue;
  const normalized = raw.replace(/[^a-z0-9]/g,'');
  const titleNormalized = String(n.title || '').toLowerCase().replace(/[^a-z0-9]/g,'');
  // Require the explicit model identifier in the title, not merely in
  // a model field. A notice about an unrelated topic cannot invent a model.
  if (normalized.length < 4 || !titleNormalized.includes(normalized)) continue;
  if (known.some(m => m.status !== 'review' && m.product === n.product && [m.slug,m.name,...(m.aliases||[])].some(a => String(a).toLowerCase().replace(/[^a-z0-9]/g,'') === normalized))) continue;
  const slug = raw.replace(/_/g,'-');
  const fnl = String(n.title || '').match(/\bFNL\s*:?\s*\d{3,}\b/i);
  const name = fnl ? fnl[0].toUpperCase().replace(/\s*:?\s*(\d+)/, ':$1') : raw.replace(/[-_]+/g,' ').replace(/\b[a-z]/g, c => c.toUpperCase());
  const item = found.get(n.product + ':' + slug) || {slug,product:n.product,name,status:'discovered',aliases:[name.toLowerCase(), name.toLowerCase().replace(':',' '), normalized],articles:[],articleCount:0,autoDetected:true};
  item.articleCount++;
  if (item.articles.length < 80) item.articles.push({id:String(n.entry_id),title:n.title,url:n.source_url || ''});
  found.set(n.product + ':' + slug,item);
 }
 return [...found.values()];
}
