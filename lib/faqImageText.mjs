function attributeValue(tag, name) {
  const match=String(tag).match(new RegExp('(?:^|[\\s<])'+name+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}
function trustedHost(host) {
  return /(?:^|\.)intercomcdn\.com$/i.test(host) || String(host).toLowerCase() === 'fundednext-4437d8102f73.intercom-attachments-1.com';
}

// Rotate on authentication and quota responses. Allow one alternate key on
// a timeout or temporary outage because the model may be busy across projects.
export async function useVisionKeyPool(keys, call, start = Math.floor(Math.random() * Math.max(1, keys?.length || 0)), unavailable = new Set()) {
  const pool=[...new Set((keys || []).filter(Boolean))];
  if (!pool.length) throw new Error('No Gemini keys configured for FAQ image reading.');
  let last, temporaryFailures = 0;
  for(let i=0;i<pool.length;i++) {
    const key=pool[(start+i)%pool.length];
    if(unavailable.has(key)) continue;
    try { return await call(key); }
    catch(error) {
      last = error;
      const status = Number(error?.status);
      if ([401,403,429].includes(status)) { unavailable.add(key); continue; }
      const temporary = [502,503,504].includes(status) || /too long to respond|timed? out/i.test(error?.message || '');
      if (!temporary || ++temporaryFailures >= 2) throw error;
      unavailable.add(key);
    }
  }
  throw last || new Error('All configured Gemini keys are unavailable or rate limited in this indexing batch.');
}

// Extract visible FAQ image references without executing article HTML.
// The source article is untrusted data; only Intercom's image CDN is fetched.
export function faqImages(html) {
  const found = new Map();
  for (const match of String(html || '').matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const get = name => attributeValue(tag, name);
    const raw = get('src').replace(/&amp;/gi, '&').replace(/&#38;/g, '&');
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || !trustedHost(url.hostname)) continue;
    const width = Number(get('width')), height = Number(get('height'));
    if ((width && width < 160) || (height && height < 100)) continue;
    const key = `${url.origin}${url.pathname}`;
    if (!found.has(key)) found.set(key, { url: url.toString(), alt: get('alt').slice(0, 500), key });
  }
  return [...found.values()];
}

// Report potentially meaningful images that cannot safely be fetched. They
// must not disappear silently just because their host is outside the allowlist.
export function unsupportedFaqImages(html) {
  const found=[];
  for (const match of String(html || '').matchAll(/<img\b[^>]*>/gi)) {
    const tag=match[0];
    const get=name=>attributeValue(tag,name);
    const width=Number(get('width')),height=Number(get('height'));
    if ((width && width<160)||(height && height<100)) continue;
    const raw=get('src').replace(/&amp;/gi,'&').replace(/&#38;/g,'&');
    if(!raw) continue;
    let url; try {url=new URL(raw);} catch {found.push('Invalid or relative image URL');continue;}
    if(url.protocol!=='https:'||url.username||url.password||!trustedHost(url.hostname)) found.push('Image host is outside the trusted Intercom CDN');
  }
  return found;
}

export function numericTokens(text) {
  return [...String(text || '').toLowerCase().matchAll(/(?:\$\s*)?\d[\d,]*(?:\.\d+)?\s*%?/g)]
    .map(m => m[0].replace(/\s|,/g, '')).sort();
}

// Require a second independent reading to agree on every number. When it does
// not, no image transcription is indexed as policy.
export function agreeOnNumbers(first, second) {
  return JSON.stringify(numericTokens(first)) === JSON.stringify(numericTokens(second));
}

// Download only trusted public image hosts, with redirects disabled so the
// allowlist cannot be bypassed. Never fetch arbitrary image URLs from HTML.
export async function downloadFaqImage(image, fetchImpl = fetch) {
  const url = new URL(image.url);
  if (url.protocol !== 'https:' || url.username || url.password || !trustedHost(url.hostname)) throw new Error('FAQ image host is not permitted');
  const response = await fetchImpl(url.toString(), { redirect:'error', signal:AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`FAQ image download failed (${response.status})`);
  const type = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['image/png','image/jpeg','image/webp','image/gif'].includes(type)) throw new Error('FAQ image has an unsupported content type');
  // Leave room for base64 and the prompt in the inline model request.
  const max = 14 * 1024 * 1024;
  if (Number(response.headers.get('content-length') || 0) > max) throw new Error('FAQ image is too large');
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), parts = [];
    let size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) { await reader.cancel(); throw new Error('FAQ image is too large'); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
    bytes = Buffer.concat(parts, size);
  } else bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > max) throw new Error('FAQ image is empty or too large');
  return `data:${type};base64,${bytes.toString('base64')}`;
}

export async function readFaqImage(image, vision, fetchImpl) {
  const dataUrl = await downloadFaqImage(image, fetchImpl);
  const first = String(await vision(dataUrl, 'transcribe') || '').trim();
  if (!first) throw new Error('FAQ image transcription was empty');
  const verification = String(await vision(dataUrl, 'verify', first) || '').trim();
  let parsed;
  try { parsed = JSON.parse(verification.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { throw new Error('FAQ image verification was not valid JSON'); }
  if (parsed.supported !== true || !String(parsed.reading || '').trim() || !agreeOnNumbers(first, parsed.reading)) throw new Error('FAQ image transcription could not be verified');
  return first;
}
