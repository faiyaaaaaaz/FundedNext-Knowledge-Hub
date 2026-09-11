import {useEffect,useState} from 'react';

// One shared layer for existing screens. It observes user-initiated requests;
// it never starts requests, retries mutations, or equates a click with a save.
export default function InteractionFeedback(){
 const [notice,setNotice]=useState(null);
 useEffect(()=>{
  let intent=null,serial=0,clearTimer;const pending=new Map();const original=window.fetch;
  function show(message,tone='working'){clearTimeout(clearTimer);setNotice({message,tone});if(tone!=='working')clearTimer=setTimeout(()=>setNotice(null),tone==='error'?9000:3500);}
  function click(event){
   const button=event.target.closest?.('button,[role="button"],summary');
   if(!button||button.disabled)return;
   if(button.dataset.requestPending){event.preventDefault();event.stopImmediatePropagation();return;}
   if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches)button.animate?.([{transform:'scale(1)'},{transform:'scale(.97)'},{transform:'scale(1)'}],{duration:180});
   intent={id:++serial,button,at:Date.now(),count:0,error:null,label:(button.getAttribute('aria-label')||button.textContent||'Request').trim().replace(/\s+/g,' ').slice(0,65)};
  }
  async function observedFetch(input,options){
   const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,window.location.href);
   const method=String(options?.method||input?.method||'GET').toUpperCase();
   // A confirmation dialog or file read can precede a write request. Keep its
   // click association longer; background GET polling uses a short window.
   const action=intent&&Date.now()-intent.at<(method==='GET'?800:30000)&&url.origin===location.origin&&url.pathname.startsWith('/api/')?intent:null;
   if(!action)return original.call(window,input,options);
   action.count++;pending.set(action.id,action);action.button.dataset.requestPending='true';action.button.setAttribute('aria-busy','true');show(action.label+' — working…');
   try{
    const response=await original.call(window,input,options);
    let payload;try{if(response.headers.get('content-type')?.includes('application/json'))payload=await response.clone().json();}catch{}
    if(!response.ok||payload?.error||payload?.ok===false)action.error=String(payload?.error||`Request failed (HTTP ${response.status}). Please try again.`);
    return response;
   }catch(error){action.error=error.name==='AbortError'?'Request cancelled.': 'Connection interrupted. Check the result before retrying.';throw error;}
   finally{
    action.count--;
    if(!action.count){pending.delete(action.id);delete action.button.dataset.requestPending;action.button.removeAttribute('aria-busy');
     if(!pending.size)show(action.error||action.label+' — response received.',action.error?'error':'complete');
    }
   }
  }
  document.addEventListener('click',click,true);window.fetch=observedFetch;
  return()=>{document.removeEventListener('click',click,true);if(window.fetch===observedFetch)window.fetch=original;clearTimeout(clearTimer);for(const action of pending.values()){delete action.button.dataset.requestPending;action.button.removeAttribute('aria-busy');}};
 },[]);
 return notice?<div className={'interaction-toast '+notice.tone} role="status" aria-live="polite"><span aria-hidden="true">{notice.tone==='working'?'◌':notice.tone==='error'?'!':'✓'}</span><p>{notice.message}</p><button aria-label="Dismiss status" onClick={()=>setNotice(null)}>×</button></div>:null;
}
