// All server-side logic lives here. This file only runs on the server
// (inside the API routes), never in the visitor's browser. Your keys never
// leave the server.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// ---------- Supabase (connects as the owner, so it can read the locked tables) ----------
export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase settings are missing. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------- Password gate ----------
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

// ---------- Encryption for the vault (AES-256-GCM) ----------
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

// ---------- The vault (keys stored encrypted in the "settings" table) ----------
async function getRaw(sb, key) {
  const { data } = await sb.from('settings').select('value').eq('key', key).maybeSingle();
  return data ? data.value : null;
}

const DEFAULT_MODEL = 'gpt-5.6-luna';

export async function getKeys() {
  const sb = supabaseAdmin();
  const encIntercom = await getRaw(sb, 'intercom_token');
  const encOpenai = await getRaw(sb, 'openai_key');
  const model = await getRaw(sb, 'chat_model');
  return {
    intercomToken: encIntercom ? tryDecrypt(encIntercom) : null,
    openaiKey: encOpenai ? tryDecrypt(encOpenai) : null,
    chatModel: model || DEFAULT_MODEL
  };
}

export async function keysStatus() {
  const sb = supabaseAdmin();
  const encIntercom = await getRaw(sb, 'intercom_token');
  const encOpenai = await getRaw(sb, 'openai_key');
  const model = await getRaw(sb, 'chat_model');
  return {
    intercomSet: !!encIntercom,
    openaiSet: !!encOpenai,
    chatModel: model || DEFAULT_MODEL
  };
}

export async function saveKeys({ intercomToken, openaiKey, chatModel }) {
  const sb = supabaseAdmin();
  const rows = [];
  if (intercomToken) rows.push({ key: 'intercom_token', value: encrypt(intercomToken) });
  if (openaiKey) rows.push({ key: 'openai_key', value: encrypt(openaiKey) });
  if (chatModel) rows.push({ key: 'chat_model', value: chatModel }); // model name isn't secret
  if (rows.length) {
    const { error } = await sb.from('settings').upsert(rows);
    if (error) throw new Error('Could not save keys: ' + error.message);
  }
}

// ---------- Intercom: fetch every published article ----------
function startingAfterFromNext(next) {
  if (!next) return null;
  if (typeof next === 'string') {
    try { return new URL(next).searchParams.get('starting_after'); } catch { return null; }
  }
  return next.starting_after || null;
}

export async function fetchAllPublishedArticles(token) {
  const out = [];
  let startingAfter = null;
  for (let i = 0; i < 5000; i++) {
    const u = new URL('https://api.intercom.io/articles');
    u.searchParams.set('per_page', '50');
    if (startingAfter) u.searchParams.set('starting_after', startingAfter);
    const res = await fetch(u.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
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
    for (const a of data) out.push(a);
    const next = json.pages && json.pages.next;
    const sa = startingAfterFromNext(next);
    if (!sa) break;
    startingAfter = sa;
  }
  return out.filter((a) => a && a.state === 'published');
}

// ---------- Turn article HTML into clean text ----------
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

// ---------- Break long text into overlapping pieces ----------
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

// ---------- OpenAI ----------
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

export async function openaiChat(openaiKey, model, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI (chat) returned ${res.status}. If this mentions the model, change the model name in Admin. Details: ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
}
