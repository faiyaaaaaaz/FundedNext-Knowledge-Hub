// Candidate discovery is advisory. Preserve compound names; never infer that
// translated copies or repeated policy words prove a model exists.
export function normalizeModelName(value) {
 return String(value||'').replace(/^(?:(?:at|and|both|for|the|my|your|our|new|what|is|are|does|how|can|a|an)\s+)+/i,'')
 .replace(/^FundedNext\s+/i,'').replace(/^Futures\s+/i,'').trim().toLowerCase().replace(/[^a-z0-9&]+/g,' ').trim();
}
export function discoverModels(articles,known=[]) {
 const candidates=new Map();
 const generic=/^(?:available|current|close|closed|daily|both|and|at|cfd|futures|fundednext|free|a free|free trial|standard|trading|live|demo|funded|account|challenge|model|new|this)$/i;
 for(const article of articles){
  let sourceProduct;try{const host=new URL(article.url).hostname;sourceProduct=host==='help.fundednext.com'?'cfd':host==='helpfutures.fundednext.com'?'futures':null;}catch{continue;}
  if(!sourceProduct)continue;
  const title=String(article.title||'').replace(/^\[[^\]]+\]\s*/,'');
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
   const product=/^Stellar\b/i.test(name)?'cfd':sourceProduct;
   const display=product==='futures'&&!/^FNL\b/i.test(name)&&!/^Futures\b/.test(name)?'Futures '+name:name;
   const id=product+':'+key;
   const candidate=candidates.get(id)||{slug:product+'-'+key.replace(/[^a-z0-9]+/g,'-'),product,name:display,status:'review',aliases:[display.toLowerCase()],articles:[],articleCount:0,autoDetected:true,reviewNote:compound?'Compound title: verify whether this is one model, several models, or a programme. Do not approve a shortened fragment.':'Verify the full model name and product against the source.'};
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
