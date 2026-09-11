// Advisory extraction only. No candidate becomes a public scope until reviewed.
export function discoverModels(articles,known=[]) {
 const normalize=s=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
 const candidates=new Map();
 for(const article of articles){
  let host;try{host=new URL(article.url).hostname;}catch{continue;}
  const product=host==='helpfutures.fundednext.com'?'futures':host==='help.fundednext.com'?'cfd':null;
  if(!product)continue;
  const text=String(article.title||'')+'\n'+String(article.body||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/[–—]/g,'-');
  const patterns=[/\b(Stellar\s+[\w-]+(?:\s+(?:Pro|Plus|Instant|Lite|1-Step|2-Step))?)\b/gi,/\b(FNL\s*:?\s*\d{3,})\b/gi,/\b([A-Z][\w-]*(?:\s+[A-Z0-9][\w-]*){0,3})\s+(?:Account|Challenge|Model)\b/g,/\b(?:model|challenge)\s+(?:called|named)\s+["“]?([A-Z][\w-]*(?:\s+[A-Z0-9][\w-]*){0,3})/g];
  for(const pattern of patterns)for(const match of text.matchAll(pattern)){
   const name=match[1].replace(/^(?:The|My|Your|Our|New|FundedNext)\s+/,'').trim(), key=normalize(name);
   if(!key||/^(?:fundednext|stellar|trading|live|demo|free trial|challenge|account|funded|fundednext funded|futures|new|this|a|an|my|your)$/i.test(key))continue;
   if(/\b(?:rules?|loss|profit|drawdown|payout|kyc|leverage|minimum|maximum|reward|account|challenge)\b/i.test(name))continue;
   if(known.some(m=>m.product===product&&[m.name,...m.aliases||[]].some(a=>normalize(a)===key)))continue;
   const id=product+':'+key;
   const candidate=candidates.get(id)||{slug:product+'-'+key.replace(/ /g,'-'),product,name,status:'review',aliases:[name.toLowerCase()],articles:[],articleCount:0,autoDetected:true};
   if(!candidate.articles.some(a=>a.id===String(article.intercom_id))){candidate.articleCount++;candidate.articles.push({id:String(article.intercom_id),title:article.title,url:article.url,excerpt:text.slice(Math.max(0,match.index-100),match.index+match[0].length+180),location:match.index<String(article.title||'').length?'title':'article text'});}
   candidates.set(id,candidate);
  }
 }
 return [...candidates.values()].map(c=>({...c,articles:c.articles.slice(0,80)}));
}
