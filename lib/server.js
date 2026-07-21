// All server-side logic lives here. This file only runs on the server
// (inside the API routes), never in the visitor's browser.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase settings are missing. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.');
  return createClient(url, key, { auth: { persistSession: false } });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function checkPassword(provided) {
  const expected = process.env.APP_PASSWORD;
  if (!expected || provided == null) return false;
  return safeEqual(provided, expected);
}

export function getPassword(req) {
  return (
    req.headers['x-app-password'] ||
    (req.body && req.body.password) ||
    (req.query && req.query.password) ||
    ''
  );
}

function encKey() {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error('ENCRYPTION_SECRET is missing. Add it in Vercel.');
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(b64) {
  const raw = Buffer.from(b64, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function tryDecrypt(b64) {
  try { return decrypt(b64); } catch { return null; }
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function hashAgentPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyAgentPassword(password, stored) {
  try {
    const [salt, expected] = String(stored || '').split(':');
    if (!salt || !expected) return false;
    return safeEqual(hashAgentPassword(password, salt), stored);
  } catch { return false; }
}

async function getRaw(sb, key) {
  const { data } = await sb.from('settings').select('value').eq('key', key).maybeSingle();
  return data ? data.value : null;
}

async function getAgentVersion(sb) {
  return (await getRaw(sb, 'agent_session_version')) || '1';
}

export async function createLoginSession(password) {
  let role = null;
  let version = 'admin';
  if (checkPassword(password)) {
    role = 'admin';
  } else {
    const sb = supabaseAdmin();
    const stored = await getRaw(sb, 'agent_password_hash');
    if (!verifyAgentPassword(password, stored)) return null;
    role = 'agent';
    version = await getAgentVersion(sb);
  }
  const payload = b64url(JSON.stringify({ role, version, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }));
  const signature = crypto.createHmac('sha256', encKey()).update(payload).digest('base64url');
  return { token: `${payload}.${signature}`, role };
}

export async function authenticateRequest(req) {
  const token = req.headers['x-app-session'];
  if (token) {
    try {
      const [payload, signature] = String(token).split('.');
      const expected = crypto.createHmac('sha256', encKey()).update(payload).digest('base64url');
      if (!safeEqual(signature, expected)) return null;
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!data.exp || Date.now() > data.exp) return null;
      if (data.role === 'admin') return { role: 'admin' };
      if (data.role === 'agent') {
        const current = await getAgentVersion(supabaseAdmin());
        if (String(data.version) === String(current)) return { role: 'agent' };
      }
    } catch { return null; }
  }

  // Keeps older browser sessions working until they sign in through the new screen.
  const password = getPassword(req);
  if (checkPassword(password)) return { role: 'admin' };
  return null;
}

export async function getAgentAccessStatus() {
  const stored = await getRaw(supabaseAdmin(), 'agent_password_hash');
  return { agentPasswordSet: !!stored };
}

export async function setAgentPassword(password) {
  const clean = String(password || '');
  if (clean.length < 10) throw new Error('Agent password must be at least 10 characters.');
  const sb = supabaseAdmin();
  const nextVersion = String(Number(await getAgentVersion(sb)) + 1);
  const { error } = await sb.from('settings').upsert([
    { key: 'agent_password_hash', value: hashAgentPassword(clean) },
    { key: 'agent_session_version', value: nextVersion }
  ]);
  if (error) throw new Error('Could not update agent access: ' + error.message);
}

export async function revokeAgentSessions() {
  const sb = supabaseAdmin();
  const nextVersion = String(Number(await getAgentVersion(sb)) + 1);
  const { error } = await sb.from('settings').upsert({ key: 'agent_session_version', value: nextVersion });
  if (error) throw new Error('Could not log out agents: ' + error.message);
}

const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_PROVIDER = 'openai';

export const DEFAULT_PROMPT =
  "You are a support knowledge assistant for FundedNext. Answer the user's question " +
  'using ONLY the knowledge-base excerpts provided.\n' +
  'Rules:\n' +
  '1. Answer the specific question asked, directly. Prefer the excerpt that most exactly matches the question.\n' +
  "2. If the excerpts genuinely do not contain the answer, reply only that you couldn't find it in the knowledge base.\n" +
  '3. Be concise: a few sentences, or a short list using "- " lines when the answer is a list.\n' +
  '4. Include specific numbers, percentages, and conditions when the excerpts state them.\n' +
  '5. You may use **bold** for key terms. Never write URLs yourself; sources are shown separately.';

export async function getPrompt() {
  const sb = supabaseAdmin();
  const p = await getRaw(sb, 'chat_prompt');
  return p && p.trim() ? p : DEFAULT_PROMPT;
}

export async function getKeys() {
  const sb = supabaseAdmin();
  const encIntercom = await getRaw(sb, 'intercom_token');
  const encOpenai = await getRaw(sb, 'openai_key');
  const encGroq = await getRaw(sb, 'groq_key');
  const model = await getRaw(sb, 'chat_model');
  const provider = await getRaw(sb, 'chat_provider');
  return {
    intercomToken: encIntercom ? tryDecrypt(encIntercom) : null,
    openaiKey: encOpenai ? tryDecrypt(encOpenai) : null,
    groqKey: encGroq ? tryDecrypt(encGroq) : null,
    chatModel: model || DEFAULT_MODEL,
    chatProvider: provider === 'groq' ? 'groq' : DEFAULT_PROVIDER
  };
}

export async function keysStatus() {
  const sb = supabaseAdmin();
  const encIntercom = await getRaw(sb, 'intercom_token');
  const encOpenai = await getRaw(sb, 'openai_key');
  const encGroq = await getRaw(sb, 'groq_key');
  const model = await getRaw(sb, 'chat_model');
  const provider = await getRaw(sb, 'chat_provider');
  const prompt = await getRaw(sb, 'chat_prompt');
  return {
    intercomSet: !!encIntercom,
    openaiSet: !!encOpenai,
    groqSet: !!encGroq,
    chatModel: model || DEFAULT_MODEL,
    chatProvider: provider === 'groq' ? 'groq' : DEFAULT_PROVIDER,
    chatPrompt: prompt && prompt.trim() ? prompt : DEFAULT_PROMPT
  };
}

export async function saveKeys({ intercomToken, openaiKey, groqKey, chatModel, chatProvider, chatPrompt }) {
  const sb = supabaseAdmin();
  const rows = [];
  if (intercomToken) rows.push({ key: 'intercom_token', value: encrypt(intercomToken) });
  if (openaiKey) rows.push({ key: 'openai_key', value: encrypt(openaiKey) });
  if (groqKey) rows.push({ key: 'groq_key', value: encrypt(groqKey) });
  if (chatModel) rows.push({ key: 'chat_model', value: chatModel });
  if (chatProvider === 'openai' || chatProvider === 'groq') {
    rows.push({ key: 'chat_provider', value: chatProvider });
  }
  if (typeof chatPrompt === 'string') rows.push({ key: 'chat_prompt', value: chatPrompt });
  if (rows.length) {
    const { error } = await sb.from('settings').upsert(rows);
    if (error) throw new Error('Could not save keys: ' + error.message);
  }
}

// ---------- Intercom: fetch every published article ----------
function urlParam(urlStr, name) {
  try { return new URL(urlStr).searchParams.get(name); } catch { return null; }
}

// Fetches ALL articles across ALL pages. Handles every Intercom pagination
// style (cursor object, next-url string, and plain page numbers), dedupes by
// id, and uses total_pages as a fallback so it never stops early.
export async function fetchAllPublishedArticles(token) {
  const byId = new Map();
  let startingAfter = null;
  let page = 1;
  for (let i = 0; i < 10000; i++) {
    const u = new URL('https://api.intercom.io/articles');
    u.searchParams.set('per_page', '150'); // 150 is Intercom's max
    u.searchParams.set('page', String(page));
    if (startingAfter) u.searchParams.set('starting_after', startingAfter);
    const res = await fetch(u.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Intercom-Version': '2.11'
      }
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Intercom returned ${res.status}. ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    let data = [];
    if (Array.isArray(json.data)) data = json.data;
    else if (json.data && Array.isArray(json.data.articles)) data = json.data.articles;
    else if (Array.isArray(json.articles)) data = json.articles;
    if (!data.length) break;
    for (const a of data) if (a && a.id != null) byId.set(String(a.id), a);

    const pages = json.pages || {};
    const next = pages.next;
    const totalPages = pages.total_pages || 1;

    if (next && typeof next === 'object' && next.starting_after) {
      startingAfter = next.starting_after;
      page = next.page || page + 1;
    } else if (typeof next === 'string' && next) {
      const sa = urlParam(next, 'starting_after');
      const pg = urlParam(next, 'page');
      if (sa) { startingAfter = sa; page = pg ? parseInt(pg, 10) : page + 1; }
      else if (pg) { startingAfter = null; page = parseInt(pg, 10); }
      else break;
    } else if (page < totalPages) {
      startingAfter = null;
      page = page + 1;
    } else {
      break;
    }
  }
  return [...byId.values()].filter((a) => a && a.state === 'published');
}

export function htmlToText(html) {
  if (!html) return '';
  let t = String(html);
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<li[^>]*>/gi, '\n• ');
  t = t.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

export function chunkText(text, size = 1200, overlap = 150) {
  const clean = (text || '').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const slice = clean.slice(start, end);
      const lastPara = slice.lastIndexOf('\n\n');
      const lastSent = slice.lastIndexOf('. ');
      const brk = lastPara > size * 0.5 ? lastPara : lastSent > size * 0.5 ? lastSent + 1 : -1;
      if (brk > 0) end = start + brk;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = end - overlap;
    if (start < 0) start = 0;
  }
  return chunks;
}

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

export async function openaiEmbed(openaiKey, inputs) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: inputs })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI (embeddings) returned ${res.status}. ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

export async function openaiChat(apiKey, model, messages, baseUrl = 'https://api.openai.com/v1') {
  const body = { model, messages };
  if (baseUrl.includes('groq.com')) body.citation_options = 'disabled';
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    const provider = baseUrl.includes('groq.com') ? 'Groq' : 'OpenAI';
    throw new Error(`${provider} (chat) returned ${res.status}. If this mentions the model, change the model in Admin. Details: ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
}
