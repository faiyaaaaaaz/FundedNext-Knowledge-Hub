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

// Global session version — bumping this forces EVERY signed-in user
// (agents and admins, Google or password) to authenticate again.
async function getGlobalVersion(sb) {
  return (await getRaw(sb, 'global_session_version')) || '1';
}

export const MASTER_GOOGLE_EMAIL = 'faiyaz@nextventures.io';

async function assertMasterAccountActive(sb = supabaseAdmin()) {
  const masterUserId = await getRaw(sb, 'master_google_user_id');
  if (!masterUserId) return;
  const { data, error } = await sb.auth.admin.getUserById(masterUserId);
  const email = data?.user?.email?.toLowerCase();
  if (error || !data?.user || email !== MASTER_GOOGLE_EMAIL) {
    throw new Error('SECURITY LOCK: The permanent Master Admin Google identity is no longer active. The workspace has been disabled.');
  }
}

function signSession({ role, version, gv, sessionId, name, email, authProvider, userId }) {
  const payload = b64url(JSON.stringify({
    role, version, gv: gv || '1', sessionId, name: name || null, email: email || null,
    authProvider: authProvider || 'password', userId: userId || null,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
  }));
  const signature = crypto.createHmac('sha256', encKey()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export async function createLoginSession(password) {
  await assertMasterAccountActive();
  if (!checkPassword(password)) return null;
  const role = 'admin';
  const version = 'admin';
  const gv = await getGlobalVersion(supabaseAdmin());
  const sessionId = crypto.randomBytes(8).toString('hex');
  const name = role === 'admin' ? 'Master Admin' : 'Shared Agent';
  return {
    token: signSession({ role, version, gv, sessionId, name, authProvider: 'password' }),
    role, sessionId, name, email: null, authProvider: 'password'
  };
}

export async function createGoogleLoginSession(accessToken) {
  const sb = supabaseAdmin();
  const { data, error } = await sb.auth.getUser(String(accessToken || ''));
  const user = data?.user;
  if (error || !user?.email) throw new Error('Google sign-in could not be verified. Please try again.');
  const provider = user.app_metadata?.provider || user.identities?.[0]?.provider;
  if (provider !== 'google') throw new Error('Please use a Google account.');
  const normalizedEmail = user.email.toLowerCase();
  const isMaster = normalizedEmail === MASTER_GOOGLE_EMAIL;

  if (isMaster) {
    const { error: registrationError } = await sb.from('settings').upsert({
      key: 'master_google_user_id', value: user.id
    });
    if (registrationError) throw new Error('Could not register the permanent Master Admin identity.');
  } else {
    await assertMasterAccountActive(sb);
  }

  const configured = String((await getRaw(sb, 'allowed_google_domains')) || '')
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!isMaster && !configured.length) throw new Error('Google access has not been configured by an Admin yet.');
  const domain = user.email.split('@')[1]?.toLowerCase();
  if (!isMaster && (!domain || !configured.includes(domain))) {
    throw new Error(`Your ${user.email} account is not authorized for this workspace.`);
  }

  const version = await getAgentVersion(sb);
  const gv = await getGlobalVersion(sb);
  const role = isMaster ? 'admin' : 'agent';
  const sessionId = crypto.randomBytes(8).toString('hex');
  const name = user.user_metadata?.full_name || user.user_metadata?.name || user.email.split('@')[0];
  const token = signSession({
    role, version, gv, sessionId, name, email: normalizedEmail, authProvider: 'google', userId: user.id
  });
  return {
    token, role, sessionId, name, email: normalizedEmail,
    avatarUrl: user.user_metadata?.avatar_url || null, authProvider: 'google'
  };
}

export async function authenticateRequest(req) {
  await assertMasterAccountActive();
  const token = req.headers['x-app-session'];
  if (token) {
    try {
      const [payload, signature] = String(token).split('.');
      const expected = crypto.createHmac('sha256', encKey()).update(payload).digest('base64url');
      if (!safeEqual(signature, expected)) return null;
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!data.exp || Date.now() > data.exp) return null;
      // Global force-logout gate: applies to everyone. Tokens issued before a
      // force-logout carry an older global version and are rejected here.
      const currentGlobal = await getGlobalVersion(supabaseAdmin());
      if (String(data.gv || '1') !== String(currentGlobal)) return null;
      const identity = {
        role: data.role, sessionId: data.sessionId || `${data.role}-legacy`,
        name: data.name || (data.role === 'admin' ? 'Master Admin' : 'Shared Agent'),
        email: data.email || null, authProvider: data.authProvider || 'password',
        userId: data.userId || null
      };
      if (data.role === 'admin') return identity;
      if (data.role === 'agent' && data.authProvider === 'google') {
        const current = await getAgentVersion(supabaseAdmin());
        if (String(data.version) === String(current)) return identity;
      }
    } catch { return null; }
  }

  // Keeps older browser sessions working until they sign in through the new screen.
  const password = getPassword(req);
  if (checkPassword(password)) return {
    role: 'admin', sessionId: 'admin-legacy', name: 'Master Admin',
    email: null, authProvider: 'password'
  };
  return null;
}

export async function logActivity(entry) {
  try {
    await supabaseAdmin().from('activity_logs').insert({
      actor_role: entry.actorRole || null,
      session_id: entry.sessionId || null,
      user_name: entry.userName || null,
      user_email: entry.userEmail || null,
      question_word_count: entry.questionWordCount ?? null,
      auth_provider: entry.authProvider || null,
      event_type: entry.eventType,
      provider: entry.provider || null,
      model: entry.model || null,
      input_tokens: entry.inputTokens ?? null,
      output_tokens: entry.outputTokens ?? null,
      estimated_cost: entry.estimatedCost ?? null,
      success: entry.success !== false,
      metadata: entry.metadata || {}
    });
  } catch {
    // Logging must never stop sign-in, search, or support work.
  }
}

export async function getAgentAccessStatus() {
  const registered = !!(await getRaw(supabaseAdmin(), 'master_google_user_id'));
  return {
    agentPasswordSet: false,
    agentLoginMode: 'google_only',
    masterGoogleEmail: MASTER_GOOGLE_EMAIL,
    masterGoogleRegistered: registered
  };
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
  const nextAgent = String(Number(await getAgentVersion(sb)) + 1);
  const nextGlobal = String(Number(await getGlobalVersion(sb)) + 1);
  const { error } = await sb.from('settings').upsert([
    { key: 'agent_session_version', value: nextAgent },
    { key: 'global_session_version', value: nextGlobal }
  ]);
  if (error) throw new Error('Could not sign everyone out: ' + error.message);
}

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_PROVIDER = 'openai';

export const DEFAULT_PROMPT =
  "You write polished, customer-ready support replies for FundedNext. Answer the user's question " +
  'using ONLY facts directly supported by the supplied FAQ evidence.\n' +
  'Rules:\n' +
  '1. Return only the reply that an agent can copy and send to a client. Do not discuss your process.\n' +
  '2. Never say excerpt, context, source number, knowledge base, database, retrieval, or provided information.\n' +
  '3. Never infer a rule from another Account type. If a question names an Account, use evidence for that exact Account only.\n' +
  '4. Never guess using words such as typically, generally, usually, or likely. Unsupported assumptions are prohibited.\n' +
  "5. If the FAQ evidence cannot confirm the answer, say: \"I’m unable to confirm this accurately right now. Please allow me some time to verify it for you.\"\n" +
  '6. Be concise and well-spaced. Use short paragraphs and "- " bullets when helpful.\n' +
  '7. Include exact numbers, percentages, time periods, and conditions only when directly supported.\n' +
  '8. Never write URLs; verified sources are displayed separately.\n' +
  '9. Follow every supplied Brand Language rule exactly.';

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
  const smart = await getRaw(sb, 'smart_retrieval');
  const normalUserFallback = await getRaw(sb, 'normal_user_gpt_fallback');
  return {
    intercomToken: encIntercom ? tryDecrypt(encIntercom) : null,
    openaiKey: encOpenai ? tryDecrypt(encOpenai) : null,
    groqKey: encGroq ? tryDecrypt(encGroq) : null,
    chatModel: model || DEFAULT_MODEL,
    chatProvider: provider === 'groq' ? 'groq' : DEFAULT_PROVIDER,
    smartRetrieval: smart == null ? true : smart === 'true',
    normalUserGptFallback: normalUserFallback == null ? true : normalUserFallback === 'true'
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
  const allowedGoogleDomains = await getRaw(sb, 'allowed_google_domains');
  const smart = await getRaw(sb, 'smart_retrieval');
  const normalUserFallback = await getRaw(sb, 'normal_user_gpt_fallback');
  return {
    intercomSet: !!encIntercom,
    openaiSet: !!encOpenai,
    groqSet: !!encGroq,
    chatModel: model || DEFAULT_MODEL,
    chatProvider: provider === 'groq' ? 'groq' : DEFAULT_PROVIDER,
    chatPrompt: prompt && prompt.trim() ? prompt : DEFAULT_PROMPT,
    smartRetrieval: smart == null ? true : smart === 'true',
    normalUserGptFallback: normalUserFallback == null ? true : normalUserFallback === 'true',
    allowedGoogleDomains: allowedGoogleDomains || '',
    googleAuthConfigured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  };
}

export async function saveKeys({ intercomToken, openaiKey, groqKey, chatModel, chatProvider, chatPrompt, allowedGoogleDomains, smartRetrieval, normalUserGptFallback }) {
  const sb = supabaseAdmin();
  const rows = [];
  if (typeof smartRetrieval === 'boolean') rows.push({ key: 'smart_retrieval', value: smartRetrieval ? 'true' : 'false' });
  if (typeof normalUserGptFallback === 'boolean') rows.push({ key: 'normal_user_gpt_fallback', value: normalUserGptFallback ? 'true' : 'false' });
  if (intercomToken) rows.push({ key: 'intercom_token', value: encrypt(intercomToken) });
  if (openaiKey) rows.push({ key: 'openai_key', value: encrypt(openaiKey) });
  if (groqKey) rows.push({ key: 'groq_key', value: encrypt(groqKey) });
  if (chatModel) rows.push({ key: 'chat_model', value: chatModel });
  if (chatProvider === 'openai' || chatProvider === 'groq') {
    rows.push({ key: 'chat_provider', value: chatProvider });
  }
  if (typeof chatPrompt === 'string') rows.push({ key: 'chat_prompt', value: chatPrompt });
  if (typeof allowedGoogleDomains === 'string') {
    const cleanDomains = allowedGoogleDomains.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean).join(',');
    rows.push({ key: 'allowed_google_domains', value: cleanDomains });
  }
  if (rows.length) {
    const { error } = await sb.from('settings').upsert(rows);
    if (error) throw new Error('Could not save keys: ' + error.message);
  }
}

export async function getBrandingRules() {
  const { data, error } = await supabaseAdmin()
    .from('branding_terms')
    .select('id,category,rule_type,match_term,required_term,notes,active')
    .eq('active', true)
    .order('category')
    .order('required_term');
  if (error) {
    if (String(error.message).toLowerCase().includes('branding_terms')) return [];
    throw new Error('Could not load Brand Language rules: ' + error.message);
  }
  return data || [];
}

export function brandingInstructions(rules) {
  if (!rules?.length) return '';
  return '\n\nMANDATORY BRAND LANGUAGE:\n' + rules.map((rule) => {
    if (rule.rule_type === 'replacement' && rule.match_term) {
      return `- Never write "${rule.match_term}". Write "${rule.required_term}" instead.${rule.notes ? ` ${rule.notes}` : ''}`;
    }
    return `- Use this exact spelling and capitalization when relevant: "${rule.required_term}".${rule.notes ? ` Note: ${rule.notes}` : ''}`;
  }).join('\n');
}

export function applyBrandingReplacements(answer, rules) {
  let output = String(answer || '');
  for (const rule of rules || []) {
    if (!rule.required_term) continue;
    if (rule.rule_type === 'replacement' && rule.match_term) {
      const escaped = rule.match_term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      output = output.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), rule.required_term);
    } else if (rule.rule_type === 'exact') {
      const escaped = rule.required_term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      output = output.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), rule.required_term);
    }
  }
  return output;
}

export async function getRelevantSnippets(question, limit = 6) {
  const { data, error } = await supabaseAdmin()
    .from('ai_snippets')
    .select('id,title,trigger_terms,instruction')
    .eq('active', true)
    .limit(200);
  if (error) {
    if (String(error.message).toLowerCase().includes('ai_snippets')) return [];
    throw new Error('Could not load corrective snippets: ' + error.message);
  }
  const words = new Set(String(question).toLowerCase().match(/[a-z0-9-]{3,}/g) || []);
  return (data || []).map((snippet) => {
    const triggers = String(snippet.trigger_terms || '').toLowerCase().match(/[a-z0-9-]{3,}/g) || [];
    const score = triggers.reduce((sum, word) => sum + (words.has(word) ? 1 : 0), 0);
    return { ...snippet, _score: score };
  }).filter((item) => item._score > 0).sort((a, b) => b._score - a._score).slice(0, limit);
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

export async function openaiChatDetailed(apiKey, model, messages, baseUrl = 'https://api.openai.com/v1') {
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
  return {
    content: (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '',
    usage: json.usage || {}
  };
}

export async function openaiChat(apiKey, model, messages, baseUrl = 'https://api.openai.com/v1') {
  return (await openaiChatDetailed(apiKey, model, messages, baseUrl)).content;
}

// ============================================================================
// SMART RETRIEVAL  — helps vague, messy, or ambiguous questions find the right
// FAQ evidence. Two layers: (1) a deterministic concept map grounded in
// FundedNext terminology, always on and instant; (2) an optional lightweight
// LLM rewrite for badly-written input, gated by the smart_retrieval setting.
// ============================================================================

// Groups of related wording. If a question touches any word in a group we add
// the whole group's expansion phrases to retrieval, so overlapping topics
// (e.g. "when do I get paid") pull evidence for EVERY meaning, not just one.
export const CONCEPT_GROUPS = [
  {
    id: 'calculator',
    match: ['max lot', 'maximum lot', 'lot size', 'calculate', 'calculation', 'how do i work out', 'how is it calculated', 'margin', 'required margin', 'pip value', 'how many pips', 'position size', 'contract size', 'leverage', 'stop loss distance', 'take profit', 'work out my'],
    expand: ['maximum lot size formula balance leverage price contract size', 'required margin formula price contract size leverage', 'how to calculate lot size from risk percentage and stop loss', 'pip value per lot for the instrument']
  },
  {
    id: 'payout_timing',
    match: ['paid', 'pay', 'payout', 'payouts', 'withdraw', 'withdrawal', 'withdrawals', 'cash', 'cashout', 'get my money', 'profit split', 'profit share', 'performance reward', 'reward', 'salary'],
    expand: ['payout cycle eligibility timing first payout', 'when a trader can request a payout trading cycle', 'performance reward profit split schedule']
  },
  {
    id: 'processing_speed',
    match: ['how long', 'how fast', 'when will', 'processing', 'process', 'receive', 'arrive', 'transfer time', 'take to', 'speed', 'delay', 'guarantee', 'brand promise', 'compensation', '24 hour', '24-hour'],
    expand: ['payout processing time 24 hour guarantee Brand Promise', 'how long after approval funds are sent compensation for delay']
  },
  {
    id: 'cycle',
    match: ['cycle', 'cycles', 'trading cycle', 'payout cycle', 'cycle time', 'cycle length', 'biweekly', 'bi-weekly', 'every 14', 'every 5', 'schedule', 'frequency', 'how often', 'how long is the cycle', 'each model', 'each account', 'per model'],
    expand: ['trading cycle length by account type', 'payout cycle time for each account model', 'how long each account cycle lasts', 'how often payouts occur after first withdrawal']
  },
  {
    id: 'withdraw_method',
    match: ['method', 'usdt', 'usdc', 'crypto', 'bank', 'riseworks', 'network', 'erc20', 'trc20', 'minimum', 'maximum', 'fee', 'fees'],
    expand: ['withdrawal methods crypto USDT USDC RiseWorks minimum maximum', 'payout method processing times and limits']
  },
  {
    id: 'targets',
    match: ['target', 'profit target', 'pass', 'passing', 'phase', 'evaluation', 'challenge', 'minimum trading days', 'consistency'],
    expand: ['profit target and minimum trading days to pass', 'evaluation phase requirements consistency rule']
  },
  {
    id: 'drawdown',
    match: ['drawdown', 'loss limit', 'daily loss', 'max loss', 'breach', 'violation', 'rule break', 'lost account', 'failed'],
    expand: ['daily loss limit and maximum loss limit rules', 'what breaches an account drawdown rules']
  },
  {
    id: 'scaling',
    match: ['scale', 'scaling', 'scale-up', 'scale up', 'grow account', 'increase balance', 'bigger account'],
    expand: ['Scale-Up program account growth requirements', 'how account balance scales per cycle']
  }
];

// Common support typos / shorthand → canonical words (helps keyword recall).
const TYPO_MAP = {
  payout: ['payot', 'payour', 'paypout', 'payput'],
  withdraw: ['withdrawl', 'widthdraw', 'withraw', 'withdow'],
  account: ['acount', 'accnt', 'acc'],
  stellar: ['steller', 'stelar'],
  challenge: ['challange', 'chalenge'],
  consistency: ['consistancy', 'consistensy'],
  minimum: ['minimun', 'minmum'],
  receive: ['recieve', 'receve']
};

export function correctTypos(text) {
  let t = ' ' + String(text || '').toLowerCase() + ' ';
  for (const [correct, wrongs] of Object.entries(TYPO_MAP)) {
    for (const w of wrongs) t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), correct);
  }
  return t.trim();
}

// Returns { expansions:[phrases], groups:[ids] } from the concept map.
export function expandConcepts(question) {
  const lower = ' ' + correctTypos(question) + ' ';
  const expansions = [];
  const groups = [];
  for (const group of CONCEPT_GROUPS) {
    if (group.match.some((m) => lower.includes(m))) {
      groups.push(group.id);
      for (const phrase of group.expand) if (!expansions.includes(phrase)) expansions.push(phrase);
    }
  }
  return { expansions, groups };
}

// Optional LLM pass: rewrites a vague/messy question into a clear support
// question, suggests a few retrieval phrasings, and flags ambiguity. Always
// wrapped so a failure never blocks the answer — retrieval falls back to the
// deterministic path. Returns null when disabled or on any error.
export async function clarifyQuery({ question, provider, model, openaiKey, groqKey }) {
  // Query understanding is deliberately kept on the small OpenAI model. The
  // OpenAI key is already required for embeddings, and this prevents a helper
  // request from consuming Groq capacity needed for the final answer.
  const key = openaiKey || (provider === 'groq' ? groqKey : null);
  const baseUrl = openaiKey ? 'https://api.openai.com/v1' : 'https://api.groq.com/openai/v1';
  const helperModel = openaiKey ? 'gpt-4o-mini' : model;
  if (!key) return null;
  const sys =
    'You prepare noisy customer-support questions for a FundedNext FAQ search. ' +
    'Return STRICT JSON only, no prose, with keys: ' +
    '"clear" (the question rewritten clearly, fixing typos/grammar; keep the original meaning, do not invent an account type), ' +
    '"queries" (array of 2-4 short search phrases covering each plausible meaning), ' +
    '"ambiguous" (true if the question could mean two genuinely different things), ' +
    '"interpretations" (array of 1-8 short labels for the distinct meanings), ' +
    '"topics" (array of up to 8 objects; one for every separate question or topic, each with "question" and 1-3 "queries"), ' +
    '"needs_clarification" (true only when a missing detail would materially change the factual answer), ' +
    '"clarifying_question" (one short, friendly question), ' +
    '"choices" (2-5 concise, mutually exclusive answers; include "Compare all" when useful). ' +
    'Do not ask for clarification when all interpretations can be answered safely, or when the user already asked for a comparison. ' +
    'Do not combine separate topics. Preserve every numbered item and every question in a long message. ' +
    'FundedNext context: a payout question may mean payout-cycle eligibility timing, the 24-hour processing Brand Promise, or withdrawal method speed — treat these as different meanings.';
  try {
    const { content } = await openaiChatDetailed(key, helperModel, [
      { role: 'system', content: sys },
      { role: 'user', content: String(question).slice(0, 12000) }
    ], baseUrl);
    const jsonText = String(content).replace(/```json|```/g, '').trim();
    const start = jsonText.indexOf('{'); const end = jsonText.lastIndexOf('}');
    if (start < 0 || end < 0) return null;
    const parsed = JSON.parse(jsonText.slice(start, end + 1));
    return {
      clear: typeof parsed.clear === 'string' ? parsed.clear.slice(0, 400) : '',
      queries: Array.isArray(parsed.queries) ? parsed.queries.filter((q) => typeof q === 'string').slice(0, 4) : [],
      ambiguous: !!parsed.ambiguous,
      interpretations: Array.isArray(parsed.interpretations) ? parsed.interpretations.filter((s) => typeof s === 'string').slice(0, 8) : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics.map((topic) => ({
        question: typeof topic?.question === 'string' ? topic.question.slice(0, 600) : '',
        queries: Array.isArray(topic?.queries) ? topic.queries.filter((q) => typeof q === 'string').slice(0, 3) : []
      })).filter((topic) => topic.question).slice(0, 8) : [],
      needsClarification: !!parsed.needs_clarification,
      clarifyingQuestion: typeof parsed.clarifying_question === 'string' ? parsed.clarifying_question.slice(0, 240) : '',
      choices: Array.isArray(parsed.choices) ? parsed.choices.filter((s) => typeof s === 'string' && s.trim()).slice(0, 5) : []
    };
  } catch { return null; }
}

// ============================================================================
// SYNC CORE  — one unit of sync work, shared by the manual /api/sync route and
// the automatic /api/cron-sync route so both behave identically.
// ============================================================================
function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function _embedWithRetry(key, inputs) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await openaiEmbed(key, inputs); }
    catch (e) { lastErr = e; await _sleep(1500 * (attempt + 1)); }
  }
  throw lastErr;
}

// Performs ONE sync step (index a batch of queued articles, or if none are
// queued, detect changes from Intercom and queue them). Returns a result
// object describing what happened, including `done`.
export async function syncStep(sb, { intercomToken, openaiKey }) {
  const started = Date.now();
  const PROCESS_BATCH = 25, EMBED_BATCH = 256, INSERT_BATCH = 50;

  const { data: todo, error: eTodo } = await sb
    .from('articles').select('intercom_id,title,url,body').eq('needs_index', true).limit(PROCESS_BATCH);
  if (eTodo) throw new Error('Reading work queue failed: ' + eTodo.message);

  if (todo && todo.length) {
    const flat = [];
    todo.forEach((a, wi) => { chunkText(htmlToText(a.body || '')).forEach((content, ci) => flat.push({ wi, ci, content })); });
    const vectors = new Array(flat.length);
    for (let i = 0; i < flat.length; i += EMBED_BATCH) {
      const vecs = await _embedWithRetry(openaiKey, flat.slice(i, i + EMBED_BATCH).map((f) => f.content));
      for (let j = 0; j < vecs.length; j++) vectors[i + j] = vecs[j];
    }
    const ids = todo.map((a) => a.intercom_id);
    { const { error } = await sb.from('chunks').delete().in('article_id', ids); if (error) throw new Error('Clearing pieces failed: ' + error.message); }
    const rows = flat.map((f, fi) => ({
      article_id: todo[f.wi].intercom_id, article_title: todo[f.wi].title || '(untitled)',
      article_url: todo[f.wi].url || '', chunk_index: f.ci, content: f.content, embedding: vectors[fi]
    }));
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const { error } = await sb.from('chunks').insert(rows.slice(i, i + INSERT_BATCH));
      if (error) throw new Error('Saving pieces failed: ' + error.message);
    }
    { const { error } = await sb.from('articles').update({ needs_index: false, last_indexed_at: new Date().toISOString() }).in('intercom_id', ids); if (error) throw new Error('Marking done failed: ' + error.message); }
    const { count } = await sb.from('articles').select('*', { count: 'exact', head: true }).eq('needs_index', true);
    return {
      ok: true, phase: 'indexing', processed: todo.length, remaining: count || 0, done: (count || 0) === 0,
      sampleTitles: todo.slice(0, 5).map((a) => a.title || '(untitled)'), chunkCount: rows.length,
      savedRows: rows.length, durationMs: Date.now() - started
    };
  }

  const articles = await fetchAllPublishedArticles(intercomToken);
  const liveIds = new Set(articles.map((a) => String(a.id)));
  const { data: stored, error: e1 } = await sb.from('articles').select('intercom_id, content_hash');
  if (e1) throw new Error('Reading stored failed: ' + e1.message);
  const storedMap = new Map((stored || []).map((r) => [r.intercom_id, r.content_hash]));
  const storedCount = storedMap.size, fetchedCount = liveIds.size;
  const safeToDelete = fetchedCount > 0 && (storedCount === 0 || fetchedCount >= storedCount * 0.5);
  let deleted = 0;
  if (safeToDelete) {
    const toDelete = [...storedMap.keys()].filter((id) => !liveIds.has(id));
    if (toDelete.length) { const { error } = await sb.from('articles').delete().in('intercom_id', toDelete); if (error) throw new Error('Removing old failed: ' + error.message); deleted = toDelete.length; }
  }
  const flagged = [];
  for (const a of articles) {
    const id = String(a.id);
    const hash = sha256((a.title || '') + '\n' + (a.body || ''));
    if (storedMap.get(id) !== hash) flagged.push({
      intercom_id: id, title: a.title || '(untitled)', url: a.url || '', state: 'published',
      updated_at: a.updated_at || null, content_hash: hash, body: a.body || '', needs_index: true
    });
  }
  for (let i = 0; i < flagged.length; i += 100) {
    const { error } = await sb.from('articles').upsert(flagged.slice(i, i + 100));
    if (error) throw new Error('Queuing changes failed: ' + error.message);
  }
  return {
    ok: true, phase: flagged.length ? 'detecting' : 'idle', processed: 0, remaining: flagged.length,
    deleted, totalPublished: articles.length, done: flagged.length === 0, scanned: articles.length,
    changedFound: flagged.length, storedBefore: storedCount, deletionGuard: safeToDelete ? 'passed' : 'activated',
    durationMs: Date.now() - started
  };
}

// Runs sync steps in a loop until finished or the time budget runs out, writes
// a full sync_logs entry, and (on success) records the last-sync markers used
// by the chat page and the interval gate.
export async function runAutoSync(sb, keys, { trigger = 'auto', budgetMs = 50000 } = {}) {
  const startedAt = new Date();
  const agg = { articlesScanned: 0, articlesChanged: 0, articlesDeleted: 0, articlesIndexed: 0, chunksWritten: 0, steps: 0, sampleTitles: [] };
  let done = false, error = null;
  try {
    const deadline = Date.now() + budgetMs;
    for (let i = 0; i < 500 && Date.now() < deadline; i++) {
      const r = await syncStep(sb, keys);
      agg.steps++;
      if (r.phase === 'indexing') {
        agg.articlesIndexed += r.processed || 0;
        agg.chunksWritten += r.chunkCount || 0;
        for (const t of r.sampleTitles || []) if (agg.sampleTitles.length < 8 && !agg.sampleTitles.includes(t)) agg.sampleTitles.push(t);
      } else {
        if (r.scanned) agg.articlesScanned = r.scanned;
        agg.articlesChanged += r.changedFound || 0;
        agg.articlesDeleted += r.deleted || 0;
      }
      if (r.done) { done = true; break; }
    }
  } catch (e) { error = String(e.message || e).slice(0, 500); }
  const finishedAt = new Date();
  const status = error ? 'failed' : (done ? 'success' : 'partial');
  try {
    await sb.from('sync_logs').insert({
      trigger, status, started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt - startedAt, articles_scanned: agg.articlesScanned, articles_changed: agg.articlesChanged,
      articles_deleted: agg.articlesDeleted, articles_indexed: agg.articlesIndexed, chunks_written: agg.chunksWritten,
      steps: agg.steps, sample_titles: agg.sampleTitles, error
    });
  } catch { /* logging must never break the sync */ }
  if (!error && done) {
    try {
      await sb.from('settings').upsert([
        { key: 'last_auto_sync_at', value: finishedAt.toISOString() },
        { key: 'last_sync_summary', value: JSON.stringify({ at: finishedAt.toISOString(), trigger, status, changed: agg.articlesChanged, indexed: agg.articlesIndexed, deleted: agg.articlesDeleted }) }
      ]);
    } catch { /* ignore */ }
  }
  return { done, status, error, ...agg, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() };
}

// Vercel Hobby permits scheduled jobs once per day. Keep the stored setting and
// Admin selector aligned with the deployment schedule so the UI never promises
// a frequency the hosting plan cannot run.
const AUTO_SYNC_INTERVALS = [24];

export async function getAutoSyncConfig(sb = supabaseAdmin()) {
  const enabled = (await getRaw(sb, 'auto_sync_enabled')) === 'true';
  const rawInterval = parseInt(await getRaw(sb, 'auto_sync_interval_hours'), 10);
  const intervalHours = AUTO_SYNC_INTERVALS.includes(rawInterval) ? rawInterval : 24;
  const lastAutoSyncAt = await getRaw(sb, 'last_auto_sync_at');
  let lastSummary = null;
  try { const s = await getRaw(sb, 'last_sync_summary'); lastSummary = s ? JSON.parse(s) : null; } catch { lastSummary = null; }
  return { enabled, intervalHours, intervalOptions: AUTO_SYNC_INTERVALS, lastAutoSyncAt, lastSummary };
}

export async function setAutoSyncConfig({ enabled, intervalHours }) {
  const sb = supabaseAdmin();
  const rows = [];
  if (typeof enabled === 'boolean') rows.push({ key: 'auto_sync_enabled', value: enabled ? 'true' : 'false' });
  if (intervalHours != null) {
    const h = AUTO_SYNC_INTERVALS.includes(Number(intervalHours)) ? Number(intervalHours) : 24;
    rows.push({ key: 'auto_sync_interval_hours', value: String(h) });
  }
  if (rows.length) { const { error } = await sb.from('settings').upsert(rows); if (error) throw new Error('Could not save auto-sync settings: ' + error.message); }
  return getAutoSyncConfig(sb);
}

export async function getSyncLogs(sb = supabaseAdmin(), limit = 25) {
  const { data, error } = await sb.from('sync_logs').select('*').order('started_at', { ascending: false }).limit(limit);
  if (error) {
    if (String(error.message).toLowerCase().includes('sync_logs')) return [];
    throw new Error('Could not load sync logs: ' + error.message);
  }
  return data || [];
}

export async function getLastSyncMarkers(sb = supabaseAdmin()) {
  const lastAutoSyncAt = await getRaw(sb, 'last_auto_sync_at');
  let lastSummary = null;
  try { const s = await getRaw(sb, 'last_sync_summary'); lastSummary = s ? JSON.parse(s) : null; } catch { lastSummary = null; }
  return { lastAutoSyncAt, lastSummary };
}

// ============================================================================
// KNOWLEDGE PACKS  — internal knowledge documents (e.g. the trade-calculator
// formulas and instrument/leverage reference) that admins can view and that get
// embedded into the SAME `chunks` store the chatbot searches, under `kb:` ids.
// ============================================================================
export async function listKnowledge(sb = supabaseAdmin()) {
  const { data, error } = await sb.from('knowledge_docs').select('*')
    .order('category', { ascending: true }).order('title', { ascending: true });
  if (error) {
    if (/knowledge_docs/i.test(error.message)) return [];
    throw new Error('Could not load knowledge documents: ' + error.message);
  }
  return data || [];
}

export async function saveKnowledgeDoc({ id, slug, title, category, content, enabled, source_url }) {
  const sb = supabaseAdmin();
  const row = { updated_at: new Date().toISOString() };
  if (title != null) row.title = title;
  if (category != null) row.category = category || 'General';
  if (content != null) row.content = content;
  if (source_url != null) row.source_url = source_url;
  if (typeof enabled === 'boolean') row.enabled = enabled;
  let res;
  if (id) {
    res = await sb.from('knowledge_docs').update(row).eq('id', id).select().single();
  } else {
    row.slug = (slug && slug.trim()) || ('doc-' + Date.now().toString(36));
    if (row.title == null) row.title = 'Untitled document';
    if (row.enabled === undefined) row.enabled = true;
    res = await sb.from('knowledge_docs').insert(row).select().single();
  }
  if (res.error) throw new Error('Could not save the document: ' + res.error.message);
  return res.data;
}

export async function deleteKnowledgeDoc(id) {
  const sb = supabaseAdmin();
  const { error } = await sb.from('knowledge_docs').delete().eq('id', id);
  if (error) throw new Error('Could not delete the document: ' + error.message);
  return { ok: true };
}

export async function knowledgeStatus(sb = supabaseAdmin()) {
  const docs = await listKnowledge(sb);
  let indexedChunks = 0;
  try {
    const { count } = await sb.from('chunks').select('*', { count: 'exact', head: true }).like('article_id', 'kb:%');
    indexedChunks = count || 0;
  } catch { indexedChunks = 0; }
  const indexedAt = await getRaw(sb, 'knowledge_indexed_at');
  return { docs, indexedChunks, indexedAt };
}

// Embeds every ENABLED knowledge document into the `chunks` table so retrieval
// picks it up beside the Intercom FAQ. Old knowledge chunks (kb:*) are cleared
// first, so this is a clean rebuild each time.
export async function reindexKnowledge(sb = supabaseAdmin(), { openaiKey } = {}) {
  if (!openaiKey) { const k = await getKeys(); openaiKey = k.openaiKey; }
  if (!openaiKey) throw new Error('OpenAI key is not set — add it in the API vault first.');

  const { data: docs, error } = await sb.from('knowledge_docs').select('*').eq('enabled', true);
  if (error) throw new Error('Could not read knowledge documents: ' + error.message);

  { const { error: delErr } = await sb.from('chunks').delete().like('article_id', 'kb:%');
    if (delErr) throw new Error('Could not clear old knowledge: ' + delErr.message); }

  let docCount = 0, chunkCount = 0;
  for (const doc of (docs || [])) {
    const pieces = chunkText(doc.content || '');
    if (!pieces.length) continue;
    const vectors = [];
    for (let i = 0; i < pieces.length; i += 256) {
      const vs = await openaiEmbed(openaiKey, pieces.slice(i, i + 256));
      for (const v of vs) vectors.push(v);
    }
    const rows = pieces.map((content, idx) => ({
      article_id: `kb:${doc.slug}`, article_title: doc.title, article_url: doc.source_url || '',
      chunk_index: idx, content, embedding: vectors[idx]
    }));
    for (let i = 0; i < rows.length; i += 50) {
      const { error: insErr } = await sb.from('chunks').insert(rows.slice(i, i + 50));
      if (insErr) throw new Error('Could not save knowledge chunks: ' + insErr.message);
    }
    docCount++; chunkCount += rows.length;
  }
  try { await sb.from('settings').upsert({ key: 'knowledge_indexed_at', value: new Date().toISOString() }); } catch { /* ignore */ }
  return { docs: docCount, chunks: chunkCount, at: new Date().toISOString() };
}

// ============================================================================
// DETERMINISTIC TRADE CALCULATOR  — the actual calculator logic + data, ported
// from the Ultimate Trade Calculator, run server-side. Invoked ONLY when a real
// calculation is asked, so the chatbot returns exact numbers (never LLM-guessed
// arithmetic) with a Trade Calculator reference.
// ============================================================================
export const CALC_INSTRUMENTS = {"AUDCAD": {"c": 100000, "p": 0.0001, "pv": 7.15, "mt": "Currency", "cf": 0.7228563611491109}, "AUDCHF": {"c": 100000, "p": 0.0001, "pv": 11.92, "mt": "Currency", "cf": 1.2612614332906873}, "AUDJPY": {"c": 100000, "p": 0.01, "pv": 6.86, "mt": "Currency", "cf": 0.006768283310619025}, "AUDNZD": {"c": 100000, "p": 0.0001, "pv": 5.9, "mt": "Currency", "cf": 0.5864423333037379}, "AUDSGD": {"c": 100000, "p": 0.0001, "pv": 7.7, "mt": "Currency", "cf": 0.5853831032899717}, "AUDUSD": {"c": 100000, "p": 0.0001, "pv": 10, "mt": "Currency", "cf": 1}, "CADCHF": {"c": 100000, "p": 0.0001, "pv": 11.92, "mt": "Currency", "cf": 1.2611525168971045}, "CADJPY": {"c": 100000, "p": 0.01, "pv": 6.86, "mt": "Currency", "cf": 0.00676559036547246}, "CHFJPY": {"c": 100000, "p": 0.01, "pv": 6.86, "mt": "Currency", "cf": 0.004252114278354941}, "EURAUD": {"c": 100000, "p": 0.0001, "pv": 6.43, "mt": "Currency", "cf": 0.6608921708145177}, "EURCAD": {"c": 100000, "p": 0.0001, "pv": 7.15, "mt": "Currency", "cf": 0.7232284092163187}, "EURCHF": {"c": 100000, "p": 0.0001, "pv": 11.92, "mt": "Currency", "cf": 1.2619011960033377}, "EURGBP": {"c": 100000, "p": 0.0001, "pv": 13.29, "mt": "Currency", "cf": 1.3509706236041916}, "EURHKD": {"c": 100000, "p": 0.0001, "pv": 1.28, "mt": "Currency", "cf": 0.1286271807246783}, "EURHUF": {"c": 100000, "p": 0.01, "pv": 2.78, "mt": "Currency", "cf": 0.00301293446944155}, "EURJPY": {"c": 100000, "p": 0.01, "pv": 6.86, "mt": "Currency", "cf": 0.006771410366067174}, "EURNOK": {"c": 100000, "p": 0.0001, "pv": 0.96, "mt": "Currency", "cf": 0.10126173703882385}, "EURNZD": {"c": 100000, "p": 0.0001, "pv": 5.9, "mt": "Currency", "cf": 0.5864280387770321}, "EURSGD": {"c": 100000, "p": 0.0001, "pv": 7.7, "mt": "Currency", "cf": 0.7793855302279484}, "EURTRY": {"c": 100000, "p": 0.0001, "pv": 0.35, "mt": "Currency", "cf": 0.03195040482430528}, "EURUSD": {"c": 100000, "p": 0.0001, "pv": 10, "mt": "Currency", "cf": 1}, "GBPAUD": {"c": 100000, "p": 0.0001, "pv": 6.43, "mt": "Currency", "cf": 0.6740074039334644}, "GBPCAD": {"c": 100000, "p": 0.0001, "pv": 7.15, "mt": "Currency", "cf": 0.7233832923701361}, "GBPCHF": {"c": 100000, "p": 0.0001, "pv": 11.92, "mt": "Currency", "cf": 1.2618767397111845}, "GBPJPY": {"c": 100000, "p": 0.01, "pv": 6.86, "mt": "Currency", "cf": 0.006773021021864142}, "GBPNZD": {"c": 100000, "p": 0.0001, "pv": 5.9, "mt": "Currency", "cf": 0.586724921933021}, "GBPSGD": {"c": 100000, "p": 0.0001, "pv": 7.7, "mt": "Currency", "cf": 0.7795113844875537}, "GBPUSD": {"c": 100000, "p": 0.0001, "pv": 10, "mt": "Currency", "cf": 1}, "MXNJPY": {"c": 100000, "p": 0.01, "pv": 6.86, "mt": "Currency", "cf": 0.006836603054123039}, "NOKJPY": {"c": 100000, "p": 0.01, "pv": 6.86, "mt": "Currency", "cf": 0.006787296668642068}, "NZDCAD": {"c": 100000, "p": 0.0001, "pv": 7.15, "mt": "Currency", "cf": 0.7234583127775037}, "NZDCHF": {"c": 100000, "p": 0.0001, "pv": 11.92, "mt": "Currency", "cf": 1.2623310665404148}, "NZDJPY": {"c": 100000, "p": 0.01, "pv": 6.86, "mt": "Currency", "cf": 0.0067710954634653125}, "NZDSGD": {"c": 100000, "p": 0.0001, "pv": 7.7, "mt": "Currency", "cf": 0.7794668721928403}, "SGDJPY": {"c": 100000, "p": 0.01, "pv": 6.86, "mt": "Currency", "cf": 0.006769211105818065}, "USDCAD": {"c": 100000, "p": 0.0001, "pv": 7.15, "mt": "Currency", "cf": 0.7226530037072099}, "USDCHF": {"c": 100000, "p": 0.0001, "pv": 11.92, "mt": "Currency", "cf": 1.2620048208584156}, "USDCNH": {"c": 100000, "p": 0.0001, "pv": 1.39, "mt": "Currency", "cf": 0.14056473287078164}, "USDDKK": {"c": 100000, "p": 0.0001, "pv": 1.5, "mt": "Currency", "cf": 0.1580383021629122}, "USDHUF": {"c": 100000, "p": 0.01, "pv": 2.78, "mt": "Currency", "cf": 0.0025542001266883265}, "USDJPY": {"c": 100000, "p": 0.01, "pv": 6.86, "mt": "Currency", "cf": 0.006768968341535066}, "USDMXN": {"c": 100000, "p": 0.0001, "pv": 0.52, "mt": "Currency", "cf": 0.05448088973830649}, "USDNOK": {"c": 100000, "p": 0.0001, "pv": 0.96, "mt": "Currency", "cf": 0.1012257425161278}, "USDPLN": {"c": 100000, "p": 0.0001, "pv": 2.42, "mt": "Currency", "cf": 0.2479002845895267}, "USDSGD": {"c": 100000, "p": 0.0001, "pv": 7.7, "mt": "Currency", "cf": 0.7792106596018233}, "USDTRY": {"c": 100000, "p": 0.0001, "pv": 0.35, "mt": "Currency", "cf": 0.029206383697697576}, "USDZAR": {"c": 100000, "p": 0.0001, "pv": 0.55, "mt": "Currency", "cf": 0.05779702033241379}, "ZARJPY": {"c": 100000, "p": 0.01, "pv": 6.86, "mt": "Currency", "cf": 0.006821317164217371}, "NZDUSD": {"c": 100000, "p": 0.0001, "pv": 10, "mt": "Currency", "cf": 1}, "USDHKD": {"c": 100000, "p": 0.0001, "pv": 1.28, "mt": "Currency", "cf": 0.1285092668032292}, "USDSEK": {"c": 100000, "p": 0.0001, "pv": 1.03, "mt": "Currency", "cf": 0.1074368888855464}, "XAUUSD": {"c": 100, "p": 0.1, "pv": 10, "mt": "Commodity", "cf": 1}, "XAGUSD": {"c": 5000, "p": 0.01, "pv": 50, "mt": "Commodity", "cf": 1}, "XPTUSD": {"c": 100, "p": 0.1, "pv": 10, "mt": "Commodity", "cf": 1}, "UKOUSD": {"c": 100, "p": 0.01, "pv": 1, "mt": "Commodity", "cf": 1}, "USOUSD": {"c": 100, "p": 0.01, "pv": 1, "mt": "Commodity", "cf": 1}, "AUS200": {"c": 10, "p": 1, "pv": 6.43, "mt": "Indice", "cf": 1}, "EUSTX50": {"c": 10, "p": 1, "pv": 11.21, "mt": "Indice", "cf": 1}, "FRA40": {"c": 10, "p": 1, "pv": 11.21, "mt": "Indice", "cf": 1}, "US2000": {"c": 10, "p": 1, "pv": 10, "mt": "Indice", "cf": 1}, "VIX": {"c": 10, "p": 1, "pv": 10, "mt": "Indice", "cf": 1}, "JP225": {"c": 10, "p": 1, "pv": 0.07, "mt": "Indice", "cf": 0.006768968341535066}, "GER30": {"c": 10, "p": 1, "pv": 11.21, "mt": "Indice", "cf": 1}, "HK50": {"c": 10, "p": 1, "pv": 1.28, "mt": "Indice", "cf": 0.1285092668032292}, "NDX100": {"c": 10, "p": 1, "pv": 10, "mt": "Indice", "cf": 1}, "NTH25": {"c": 10, "p": 1, "pv": 11.21, "mt": "Indice", "cf": 1}, "SPX500": {"c": 10, "p": 1, "pv": 10, "mt": "Indice", "cf": 1}, "SWI20": {"c": 10, "p": 1, "pv": 11.92, "mt": "Indice", "cf": 1.2620048208584156}, "UK100": {"c": 10, "p": 1, "pv": 13.29, "mt": "Indice", "cf": 1}, "US30": {"c": 10, "p": 1, "pv": 10, "mt": "Indice", "cf": 1}, "ADAUSD": {"c": 100, "p": 0.001, "pv": 0.1, "mt": "Crypto", "cf": 1}, "BCHUSD": {"c": 1, "p": 0.01, "pv": 0.01, "mt": "Crypto", "cf": 1}, "BTCUSD": {"c": 1, "p": 0.1, "pv": 0.1, "mt": "Crypto", "cf": 1}, "DOGUSD": {"c": 1000, "p": 0.0001, "pv": 0.1, "mt": "Crypto", "cf": 1}, "ETHUSD": {"c": 1, "p": 0.1, "pv": 0.1, "mt": "Crypto", "cf": 1}, "LNKUSD": {"c": 100, "p": 0.01, "pv": 1, "mt": "Crypto", "cf": 1}, "LTCUSD": {"c": 1, "p": 0.1, "pv": 0.1, "mt": "Crypto", "cf": 1}, "XLMUSD": {"c": 100, "p": 0.0001, "pv": 0.01, "mt": "Crypto", "cf": 1}, "XMRUSD": {"c": 1, "p": 0.1, "pv": 0.1, "mt": "Crypto", "cf": 1}, "XRPUSD": {"c": 100, "p": 0.001, "pv": 0.1, "mt": "Crypto", "cf": 1}};
export const CALC_LEVERAGE = {"1-step": {"Currency": {"challenge": 30, "fundednext": 30}, "Indice": {"challenge": 5, "fundednext": 5}, "Commodity": {"challenge": 10, "fundednext": 5}}, "2-step": {"Currency": {"challenge": 100, "fundednext": 100}, "Indice": {"challenge": 15, "fundednext": 5}, "Commodity": {"challenge": 15, "fundednext": 5}}, "lite": {"Currency": {"challenge": 100, "fundednext": 100}, "Indice": {"challenge": 15, "fundednext": 5}, "Commodity": {"challenge": 15, "fundednext": 5}}, "crypto": {"Crypto": {"challenge": 1}}};

const _CALC_ALIASES = { GOLD: 'XAUUSD', XAU: 'XAUUSD', SILVER: 'XAGUSD', XAG: 'XAGUSD', OIL: 'USOUSD', BITCOIN: 'BTCUSD', BTC: 'BTCUSD', ETH: 'ETHUSD', ETHEREUM: 'ETHUSD' };

function calcFindInstrument(name, data) {
  if (!name) return null;
  const table = (data && data.instruments) || CALC_INSTRUMENTS;
  const key = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const resolved = _CALC_ALIASES[key] || key;
  if (table[resolved]) return { symbol: resolved, ...table[resolved] };
  return null;
}

function _calcStep(text) {
  const n = String(text || '').toLowerCase();
  if (/2[\s-]?step/.test(n)) return '2-step';
  if (/lite/.test(n)) return 'lite';
  if (/1[\s-]?step/.test(n)) return '1-step';
  if (/instant/.test(n)) return 'instant';
  if (/express/.test(n)) return 'express';
  if (/futures?/.test(n)) return 'futures';
  if (/crypto/.test(n)) return 'crypto';
  return null;
}
function _calcPhase(text) {
  const n = String(text || '').toLowerCase();
  if (/fund(ed)?next|funded/.test(n)) return 'fundednext';
  if (/challenge|evaluation|phase|instant/.test(n)) return 'challenge';
  return null;
}

// Resolves leverage. Returns { leverage } or { ambiguous:true } or { unknown:true }.
function calcResolveLeverage({ manualLeverage, accountModel, marketType, data }) {
  if (manualLeverage && Number(manualLeverage) > 0) return { leverage: Number(manualLeverage) };
  const LV = (data && data.leverage) || CALC_LEVERAGE;
  if (marketType === 'Crypto') {
    const cm = LV.crypto && LV.crypto.Crypto;
    const vals = cm ? [...new Set(Object.values(cm))] : [];
    return { leverage: vals.length ? vals[0] : 1 };
  }
  const step = _calcStep(accountModel);
  if (!step) return { unknown: true };
  const byMarket = LV[step] && LV[step][marketType];
  if (!byMarket) return { unknown: true };
  const phase = _calcPhase(accountModel);
  if (phase && byMarket[phase] != null) return { leverage: byMarket[phase] };
  const values = [...new Set(Object.values(byMarket))];
  if (values.length === 1) return { leverage: values[0] };
  return { ambiguous: true, options: byMarket };
}

function _fMoney(v) { return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _fNum(v, d = 5) { return Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d }); }

// Each computer returns { ok, macro } or { ok:false, missing:[...] }.
const CALC_ENGINES = {
  margin(p, inst, lev) {
    const need = [];
    if (!p.price) need.push('the current price');
    if (!p.lot) need.push('the lot size');
    if (lev == null) need.push('the account model or a manual leverage');
    if (need.length) return { ok: false, missing: need };
    const pre = (p.price * inst.c * p.lot) / lev;
    const usd = pre * inst.cf;
    return { ok: true, macro:
`The formula for required margin is: Required Margin = (Price × Contract Size × Lot Size) ÷ Leverage, converted to USD.
For ${inst.symbol} (contract size ${inst.c}, conversion factor ${inst.cf}) at a price of ${_fNum(p.price)}, a lot size of ${_fNum(p.lot, 2)}, and leverage of 1:${_fNum(lev, 0)}: (${_fNum(p.price)} × ${inst.c} × ${_fNum(p.lot, 2)}) ÷ ${_fNum(lev, 0)}${inst.cf !== 1 ? ` × ${inst.cf}` : ''} = $${_fMoney(usd)}.
So the required margin to open this trade is $${_fMoney(usd)}.` };
  },
  maxlot(p, inst, lev) {
    const need = [];
    if (!p.balance) need.push('the account balance (or available margin)');
    if (!p.price) need.push('the current price');
    if (lev == null) need.push('the account model or a manual leverage');
    if (need.length) return { ok: false, missing: need };
    const maxLot = (p.balance * lev) / (p.price * inst.c * inst.cf);
    if (maxLot < 0.01) return { ok: true, macro:
`Using Max Lot = (Balance × Leverage) ÷ (Price × Contract Size), the result for ${inst.symbol} with a balance of $${_fMoney(p.balance)}, leverage 1:${_fNum(lev, 0)}, and price ${_fNum(p.price)} is below 0.01 lots — effectively "Not Enough Margin" to open the trade. Consider a smaller position or more balance.` };
    return { ok: true, macro:
`The formula for maximum lot size is: Max Lot = (Balance × Leverage) ÷ (Price × Contract Size × Conversion Factor).
For ${inst.symbol} (contract size ${inst.c}, conversion factor ${inst.cf}) with a balance of $${_fMoney(p.balance)}, leverage 1:${_fNum(lev, 0)}, and price ${_fNum(p.price)}: (${_fMoney(p.balance)} × ${_fNum(lev, 0)}) ÷ (${_fNum(p.price)} × ${inst.c}${inst.cf !== 1 ? ` × ${inst.cf}` : ''}) = ${_fNum(maxLot, 2)} lots.
So the maximum lot size you could open is about ${_fNum(maxLot, 2)} lots (before any account allocation or loss-limit rules, which may cap it further).` };
  },
  pnl(p, inst) {
    const need = [];
    if (!p.position) need.push('buy or sell');
    if (!p.entry) need.push('the open price');
    if (!p.close) need.push('the close price');
    if (!p.lot) need.push('the lot size');
    if (need.length) return { ok: false, missing: need };
    const raw = p.close - p.entry;
    const dir = p.position === 'sell' ? -raw : raw;
    const pips = dir / inst.p;
    const usd = dir * inst.c * p.lot * inst.cf;
    return { ok: true, macro:
`PnL = Price Movement × Contract Size × Lot Size × Conversion Factor.
For a ${p.position.toUpperCase()} on ${inst.symbol} from ${_fNum(p.entry)} to ${_fNum(p.close)} with ${_fNum(p.lot, 2)} lot(s): movement ${_fNum(dir)} × ${inst.c} × ${_fNum(p.lot, 2)}${inst.cf !== 1 ? ` × ${inst.cf}` : ''} = $${_fMoney(usd)} (${_fNum(pips, 2)} pips).` };
  },
  pips(p, inst) {
    const need = [];
    if (!p.entry) need.push('the opening price');
    if (!p.action) need.push('add or remove');
    if (!p.amount) need.push('the number of pips/points');
    if (need.length) return { ok: false, missing: need };
    const np = p.action === 'remove' ? p.entry - (p.amount * inst.p) : p.entry + (p.amount * inst.p);
    return { ok: true, macro:
`New Price = Open Price ${p.action === 'remove' ? '−' : '+'} (Pips × Pip Size).
For ${inst.symbol} from ${_fNum(p.entry)}, ${p.action === 'remove' ? 'removing' : 'adding'} ${_fNum(p.amount, 2)} pips (pip size ${inst.p}) gives ${_fNum(np)}.` };
  },
  risk_money(p, inst) {
    const need = [];
    if (!p.position) need.push('buy or sell');
    if (!p.entry) need.push('the entry price');
    if (!p.lot) need.push('the lot size');
    if (!p.risk) need.push('the risk amount');
    if (!p.reward) need.push('the reward amount');
    if (need.length) return { ok: false, missing: need };
    const riskMove = p.risk / (inst.c * p.lot * inst.cf);
    const rewardMove = p.reward / (inst.c * p.lot * inst.cf);
    const sl = p.position === 'buy' ? p.entry - riskMove : p.entry + riskMove;
    const tp = p.position === 'buy' ? p.entry + rewardMove : p.entry - rewardMove;
    return { ok: true, macro:
`For a ${p.position} on ${inst.symbol} at ${_fNum(p.entry)} with ${_fNum(p.lot, 2)} lot(s), risking $${_fMoney(p.risk)} for a $${_fMoney(p.reward)} reward: set Stop Loss at ${_fNum(sl)} and Take Profit at ${_fNum(tp)}.` };
  },
  risk_percent(p, inst) {
    const need = [];
    if (!p.balance) need.push('the account balance');
    if (!p.riskPct) need.push('the risk percentage');
    if (need.length) return { ok: false, missing: need };
    const riskDollar = p.balance * (p.riskPct / 100);
    let macro = `Risk in USD = Balance × (Risk% ÷ 100) = $${_fMoney(p.balance)} × ${_fNum(p.riskPct, 2)}% = $${_fMoney(riskDollar)}. So risking ${_fNum(p.riskPct, 2)}% of a $${_fMoney(p.balance)} account means $${_fMoney(riskDollar)} of risk.`;
    if (p.entry && p.slPips && p.position) {
      const lot = Math.abs(riskDollar / (inst.cf * inst.c * inst.p * p.slPips));
      const sl = p.position === 'buy' ? p.entry - (p.slPips * inst.p) : p.entry + (p.slPips * inst.p);
      let tpLine = '';
      if (p.rewardPct) {
        const rewardDollar = p.balance * (p.rewardPct / 100);
        const tp = p.position === 'buy' ? p.entry + (rewardDollar / (inst.cf * inst.c * lot)) : p.entry - (rewardDollar / (inst.cf * inst.c * lot));
        tpLine = ` and Take Profit at ${_fNum(tp)}`;
      }
      macro += `\n\nLot Size = Risk ÷ (Conversion Factor × Contract Size × Pip Size × SL pips). For ${inst.symbol} at ${_fNum(p.entry)} (${p.position}) with a ${_fNum(p.slPips, 2)}-pip stop: lot size ≈ ${_fNum(lot, 2)}, Stop Loss at ${_fNum(sl)}${tpLine}.`;
    }
    return { ok: true, macro };
  }
};

const CALC_TITLES = {
  margin: 'Trade Calculator — Required Margin', maxlot: 'Trade Calculator — Maximum Lot Size',
  pnl: 'Trade Calculator — Profit & Loss', pips: 'Trade Calculator — Add / Remove Pips',
  risk_money: 'Trade Calculator — Risk by Money & Lot', risk_percent: 'Trade Calculator — Risk by Percentage'
};

const _CALC_HINT = /\b(margin|max(?:imum)?\s*lot|lot\s*size|pip\s*value|pnl|p&l|profit\s*(?:and|&|\/)\s*loss|add(?:ing)?\s*pips|remove\s*pips|new\s*price|position\s*size|how\s*(?:do|to)\s*(?:i\s*)?calculate|work\s*out)\b/i;

async function calcExtract({ question, provider, model, openaiKey, groqKey }) {
  const key = provider === 'groq' ? groqKey : openaiKey;
  const baseUrl = provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
  if (!key) return null;
  const sys =
    'Split a customer message into calculator tasks and other questions. Return STRICT JSON only with two keys: ' +
    '"calculations" (an array) and "otherQuestions" (an array of short strings for every part that is NOT a numeric calculation the calculator performs — e.g. rules, policy, eligibility, definitions). ' +
    'Each item in "calculations" has: type (one of "margin","maxlot","pnl","pips","risk_money","risk_percent"), instrument, accountModel, manualLeverage, price, lot, balance, position ("buy"/"sell"), entry, close, risk, reward, riskPct, rewardPct, slPips, action ("add"/"remove"), amount. ' +
    'Numbers must be plain numbers or null; strings or null. If the message has no calculation, return "calculations": []. ' +
    'A calculation is a request to compute margin, maximum lot, profit/loss, a new price after pips, or risk-based lot/stop sizing. ' +
    'Questions about whether a rule exists, limits, payout, eligibility, or program definitions go in otherQuestions, NOT calculations. ' +
    'IMPORTANT: a request to explain, give an example, show the steps, or "make me understand how to calculate" the SAME calculation is PART of that calculation — do NOT put it in otherQuestions. Only put genuinely different topics (a rule, a policy, a different instrument, an unrelated question) in otherQuestions. ' +
    'margin needs price+lot+leverage(or account); maxlot needs balance+price+leverage(or account); pnl needs open+close+lot+position; ' +
    'pips needs open+action+amount; risk_money needs entry+lot+risk+reward+position; risk_percent needs balance+riskPct (entry+slPips+position add stop sizing). ' +
    'instrument is the trading symbol (e.g. EURUSD, XAUUSD). accountModel is the raw account text (e.g. "Stellar 1-step challenge").';
  try {
    const { content } = await openaiChatDetailed(key, model, [
      { role: 'system', content: sys },
      { role: 'user', content: String(question).slice(0, 800) }
    ], baseUrl);
    const t = String(content).replace(/```json|```/g, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < 0) return null;
    const parsed = JSON.parse(t.slice(a, b + 1));
    return {
      calculations: Array.isArray(parsed.calculations) ? parsed.calculations : [],
      otherQuestions: Array.isArray(parsed.otherQuestions) ? parsed.otherQuestions.filter((s) => typeof s === 'string') : []
    };
  } catch { return null; }
}

const CALC_FORMULAS = {
  margin: 'Required Margin = (Price × Contract Size × Lot Size) ÷ Leverage, converted to USD.',
  maxlot: 'Max Lot = (Balance × Leverage) ÷ (Price × Contract Size × Conversion Factor).',
  pnl: 'PnL = Price Movement × Contract Size × Lot Size × Conversion Factor.',
  pips: 'New Price = Open Price ± (Pips × Pip Size).',
  risk_money: 'Price move = Risk Amount ÷ (Contract Size × Lot Size × Conversion Factor); Stop Loss / Take Profit sit that price distance from entry.',
  risk_percent: 'Risk in USD = Balance × (Risk% ÷ 100); Lot Size = Risk in USD ÷ (Pip Value per lot × Stop-Loss pips).'
};

// Computes a single calculation intent → { ok, title, text, calcType }.
function _computeOne(item, data) {
  if (!item || !item.type || !CALC_ENGINES[item.type]) return null;
  const title = CALC_TITLES[item.type];
  const label = item.type.replace('_', ' ');
  const inst = calcFindInstrument(item.instrument, data);
  if (!inst) {
    return { ok: false, title, calcType: item.type, text: `For the ${label} calculation, I need a supported instrument symbol (for example EURUSD or XAUUSD) — which instrument is it for?` };
  }
  const ref = `${inst.symbol} values from the calculator: pip value $${inst.pv} per lot, pip size ${inst.p}, contract size ${inst.c}${inst.cf !== 1 ? `, conversion factor ${Number(inst.cf).toPrecision(6)}` : ''}.`;
  let leverage = null;
  if (item.type === 'margin' || item.type === 'maxlot') {
    const lv = calcResolveLeverage({ manualLeverage: item.manualLeverage, accountModel: item.accountModel, marketType: inst.mt, data });
    if (lv.leverage != null) leverage = lv.leverage;
    else if (lv.ambiguous) {
      return { ok: false, title, calcType: item.type, text: `For ${inst.symbol} (${inst.mt}) the leverage differs between the Challenge and Funded phases — which one is it (or what manual leverage should I use)?` };
    }
  }
  const result = CALC_ENGINES[item.type](item, inst, leverage);
  if (!result.ok) {
    // Missing an input: still teach the method with the EXACT instrument values,
    // so the answer never invents figures like a wrong pip value.
    if (item.type === 'risk_percent' && item.balance && item.slPips) {
      const dist = item.slPips * inst.p;
      const entryUsed = (item.entry != null) ? item.entry : (inst.sp != null ? inst.sp : null);
      const entryNote = item.entry != null ? 'your entry' : 'an example entry';
      let slBlock;
      if (entryUsed != null) {
        slBlock =
`Step 2 — Place the stop-loss. Convert pips to a price distance: ${_fNum(item.slPips, 0)} pips × pip size ${inst.p} = ${_fNum(dist)} in price. The stop sits that far from entry: Buy → SL = Entry − ${_fNum(dist)}; Sell → SL = Entry + ${_fNum(dist)}.
Example (assuming ${entryNote} of ${_fNum(entryUsed)} on ${inst.symbol}): a Buy has its SL at ${_fNum(entryUsed - dist)}, and a Sell has its SL at ${_fNum(entryUsed + dist)}.`;
      } else {
        slBlock =
`Step 2 — Place the stop-loss. Convert pips to a price distance: ${_fNum(item.slPips, 0)} pips × pip size ${inst.p} = ${_fNum(dist)} in price. The stop sits that far from entry: Buy → SL = Entry − ${_fNum(dist)}; Sell → SL = Entry + ${_fNum(dist)}. Tell me your entry price and I'll give the exact SL price.`;
      }
      const oneP = item.balance * 0.01;
      const oneLot = oneP / (inst.pv * item.slPips);
      return { ok: false, title, calcType: item.type, text:
`Here's how to set a ${_fNum(item.slPips, 0)}-pip stop-loss on ${inst.symbol} for a $${_fMoney(item.balance)} account, and how to size the trade, so you can do it yourself:
${slBlock}
Step 3 — Size the lot from your risk. Risk in USD = Balance × (Risk% ÷ 100); Lot Size = Risk ÷ (Pip Value × Stop-Loss pips) = Risk ÷ ($${inst.pv} × ${_fNum(item.slPips, 0)}). Example at 1% risk: Risk = $${_fMoney(oneP)}, Lot = ${_fNum(oneLot, 2)} lots.
Choose a Risk% that respects your account's own max-risk rule, and send me your entry price and Risk% for the exact figures. (${ref})` };
    }
    return { ok: false, title, calcType: item.type, text: `For the ${label} on ${inst.symbol} I still need ${result.missing.join(', ')}. Use ${CALC_FORMULAS[item.type]} ${ref} Once you provide that, I can give the exact figure.` };
  }
  return { ok: true, title, calcType: item.type, text: result.macro };
}

// Main entry. Runs the calculator over a (possibly mixed) message and returns
// { results:[{ok,title,text,calcType}], other:[strings], pureCalc:bool } — or
// null when the message contains no calculation. The caller decides whether to
// answer purely from these results (pureCalc) or merge them into the FAQ answer.
export async function runCalculators({ question, provider, model, openaiKey, groqKey }) {
  if (!_CALC_HINT.test(question || '')) return null;
  const ex = await calcExtract({ question, provider, model, openaiKey, groqKey });
  if (!ex || !ex.calculations.length) return null;
  const data = await loadCalcData();
  const results = ex.calculations.map((c) => _computeOne(c, data)).filter(Boolean);
  if (!results.length) return null;
  return { results, other: ex.otherQuestions, pureCalc: ex.otherQuestions.length === 0 };
}

export const CALC_SAMPLE = {"AUDCAD": 0.91375, "AUDCHF": 0.52369, "AUDJPY": 97.589, "AUDNZD": 1.1263, "AUDSGD": 1.128338, "CADCHF": 0.57301, "CADJPY": 106.813, "CHFJPY": 186.352, "EURAUD": 1.78486, "EURCAD": 1.63102, "EURCHF": 0.93478, "EURGBP": 0.87315, "EURHKD": 9.17069, "EURHUF": 391.512, "EURJPY": 174.203, "EURNOK": 11.64902, "EURNZD": 2.0115, "EURSGD": 1.5135, "EURTRY": 36.91972, "GBPAUD": 2.00434, "GBPCAD": 1.86753, "GBPCHF": 1.07058, "GBPJPY": 199.459, "GBPNZD": 2.30251, "GBPSGD": 1.73306, "MXNJPY": 7.969, "NOKJPY": 14.914, "NZDCAD": 0.8108, "NZDCHF": 0.46468, "NZDJPY": 86.63, "NZDSGD": 0.75254, "SGDJPY": 115.111, "USDCAD": 1.38379, "USDCHF": 0.79239, "USDCNH": 7.11416, "USDDKK": 6.32758, "USDHUF": 391.512, "USDJPY": 147.733, "USDMXN": 18.35506, "USDNOK": 9.87891, "USDPLN": 4.03388, "USDSGD": 1.28335, "USDTRY": 34.23909, "USDZAR": 17.30193, "ZARJPY": 8.473, "USDHKD": 7.78154, "USDSEK": 9.30779, "XAUUSD": 2662.78, "XAGUSD": 38.272, "XPTUSD": 1380.81, "UKOUSD": 69.464, "USOUSD": 66.852, "AUS200": 8625.46, "EUSTX50": 5379.59, "FRA40": 7819.27, "US2000": 2265.8, "VIX": 12.1, "JP225": 39604, "GER30": 24213.78, "HK50": 24330.95, "NDX100": 22973.18, "NTH25": 926.24, "SPX500": 6288.86, "SWI20": 11942.86, "UK100": 9018.58, "US30": 44507.45, "ADAUSD": 1, "BCHUSD": 1, "BTCUSD": 1, "DOGUSD": 1, "ETHUSD": 1, "LNKUSD": 1, "LTCUSD": 1, "XLMUSD": 1, "XMRUSD": 1, "XRPUSD": 1};
// ============================================================================
// EDITABLE CALCULATOR DATA  — instruments and leverage can be overridden from
// the admin panel (stored in Supabase). The hardcoded CALC_* values are the
// fallback, so if the tables are empty or missing the calculator behaves exactly
// as before. Loaded values are cached briefly and invalidated on admin save.
// ============================================================================
let _calcCache = null;
let _calcCacheAt = 0;

export async function loadCalcData(sb = supabaseAdmin(), { force = false } = {}) {
  if (!force && _calcCache && (Date.now() - _calcCacheAt < 45000)) return _calcCache;
  // Start from the built-in defaults (deep copies), including sample prices.
  const instruments = {};
  for (const [k, v] of Object.entries(CALC_INSTRUMENTS)) {
    instruments[k] = { ...v, sp: (CALC_SAMPLE[k] != null ? CALC_SAMPLE[k] : null) };
  }
  const leverage = {};
  for (const [step, markets] of Object.entries(CALC_LEVERAGE)) {
    leverage[step] = {};
    for (const [mt, phases] of Object.entries(markets)) leverage[step][mt] = { ...phases };
  }
  try {
    const [insRes, levRes] = await Promise.all([
      sb.from('calc_instruments').select('*'),
      sb.from('calc_leverage').select('*')
    ]);
    for (const r of (insRes.data || [])) {
      instruments[r.symbol] = {
        c: Number(r.contract_size), p: Number(r.pip_size), pv: Number(r.pip_value),
        mt: r.market_type, cf: Number(r.conversion_factor), sp: (r.sample_price != null ? Number(r.sample_price) : null)
      };
    }
    for (const r of (levRes.data || [])) {
      leverage[r.step_key] = leverage[r.step_key] || {};
      leverage[r.step_key][r.market_type] = leverage[r.step_key][r.market_type] || {};
      leverage[r.step_key][r.market_type][r.phase] = Number(r.leverage);
    }
  } catch { /* tables missing → keep built-in defaults */ }
  _calcCache = { instruments, leverage };
  _calcCacheAt = Date.now();
  return _calcCache;
}

function _invalidateCalcCache() { _calcCache = null; _calcCacheAt = 0; }

export async function listCalcData(sb = supabaseAdmin()) {
  const data = await loadCalcData(sb, { force: true });
  const instruments = Object.entries(data.instruments).map(([symbol, v]) => ({
    symbol, marketType: v.mt, contractSize: v.c, pipSize: v.p, pipValue: v.pv,
    conversionFactor: v.cf, samplePrice: v.sp == null ? null : v.sp
  })).sort((a, b) => a.marketType.localeCompare(b.marketType) || a.symbol.localeCompare(b.symbol));
  const leverage = [];
  for (const [step, markets] of Object.entries(data.leverage)) {
    for (const [mt, phases] of Object.entries(markets)) {
      for (const [ph, lev] of Object.entries(phases)) leverage.push({ stepKey: step, marketType: mt, phase: ph, leverage: lev });
    }
  }
  leverage.sort((a, b) => a.stepKey.localeCompare(b.stepKey) || a.marketType.localeCompare(b.marketType) || a.phase.localeCompare(b.phase));
  return { instruments, leverage };
}

export async function saveCalcInstrument(row) {
  const sb = supabaseAdmin();
  const symbol = String(row.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!symbol) throw new Error('A symbol is required.');
  const num = (v, d = null) => (v === '' || v == null ? d : Number(v));
  const payload = {
    symbol, market_type: row.marketType || 'Currency',
    contract_size: num(row.contractSize, 0), pip_size: num(row.pipSize, 0),
    pip_value: num(row.pipValue, 0), conversion_factor: num(row.conversionFactor, 1),
    sample_price: num(row.samplePrice, null), updated_at: new Date().toISOString()
  };
  const { error } = await sb.from('calc_instruments').upsert(payload);
  if (error) throw new Error('Could not save the instrument: ' + error.message);
  _invalidateCalcCache();
  return { ok: true };
}

export async function saveCalcLeverage(row) {
  const sb = supabaseAdmin();
  const payload = {
    step_key: String(row.stepKey || '').toLowerCase().trim(),
    market_type: row.marketType, phase: String(row.phase || 'any').toLowerCase().trim(),
    leverage: Number(row.leverage), updated_at: new Date().toISOString()
  };
  if (!payload.step_key || !payload.market_type || !payload.leverage) throw new Error('Step, market and leverage are required.');
  const { error } = await sb.from('calc_leverage').upsert(payload, { onConflict: 'step_key,market_type,phase' });
  if (error) throw new Error('Could not save the leverage row: ' + error.message);
  _invalidateCalcCache();
  return { ok: true };
}

export async function deleteCalcLeverage({ stepKey, marketType, phase }) {
  const sb = supabaseAdmin();
  const { error } = await sb.from('calc_leverage').delete()
    .match({ step_key: stepKey, market_type: marketType, phase });
  if (error) throw new Error('Could not delete the leverage row: ' + error.message);
  _invalidateCalcCache();
  return { ok: true };
}

// ============================================================================
// GROUNDING VERIFIER  — an independent strict check that the drafted answer is
// actually supported by the retrieved FAQ evidence. Stops the assistant from
// confidently stating (and mis-citing) things that aren't in the evidence.
// ============================================================================
export async function verifyGrounding({ question, answer, context, provider, model, openaiKey, groqKey }) {
  const key = provider === 'groq' ? groqKey : openaiKey;
  const baseUrl = provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
  if (!key) return null;
  const sys =
    'You score how well FAQ EVIDENCE supports a draft ANSWER for a FundedNext assistant. ' +
    'An answer is well-grounded (high score) when its core claims are supported by the evidence, even if reworded, summarized, or combined. ' +
    'Lower the score when the answer states SPECIFIC facts — rules, numbers, permissions, prohibitions, timeframes — that do NOT appear anywhere in the evidence. ' +
    'General phrasing, safe hedging, or asking the customer for more detail is not a problem. Do not require exact wording. ' +
    'Return STRICT JSON only: {"grounded": true|false, "score": 0-100, "unsupported": ["short claim", ...]}. ' +
    'score = share of the answer that the evidence supports (100 = fully supported; around 60 = mostly supported with minor gaps; below 30 = the key claims are absent from the evidence).';
  try {
    const { content } = await openaiChatDetailed(key, model, [
      { role: 'system', content: sys },
      { role: 'user', content: `EVIDENCE:\n${String(context).slice(0, 9000)}\n\nANSWER:\n${String(answer).slice(0, 2200)}` }
    ], baseUrl);
    const t = String(content).replace(/```json|```/g, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < 0) return null;
    const p = JSON.parse(t.slice(a, b + 1));
    return {
      grounded: !!p.grounded,
      score: Math.max(0, Math.min(100, Number(p.score) || 0)),
      unsupported: Array.isArray(p.unsupported) ? p.unsupported.filter((s) => typeof s === 'string').slice(0, 5) : []
    };
  } catch { return null; }
}

// ============================================================================
// GROQ KEY POOL  — multiple Groq API keys the app rotates over to spread free-
// tier rate limits across many concurrent users. Keys are encrypted at rest.
// ============================================================================
export async function getGroqKeys(sb = supabaseAdmin()) {
  try {
    const { data, error } = await sb.from('groq_keys').select('*').eq('active', true).order('id', { ascending: true });
    if (!error && data && data.length) {
      return data.map((r) => ({ id: r.id, label: r.label, key: tryDecrypt(r.key_enc) })).filter((k) => k.key);
    }
  } catch { /* table missing → fall back to the single legacy key */ }
  const legacy = await getRaw(sb, 'groq_key');
  const k = legacy ? tryDecrypt(legacy) : null;
  return k ? [{ id: 0, label: 'Primary', key: k }] : [];
}

export async function listGroqKeys(sb = supabaseAdmin()) {
  try {
    const { data, error } = await sb.from('groq_keys').select('id,label,active,created_at').order('id', { ascending: true });
    if (error) { if (/groq_keys/i.test(error.message)) return []; throw new Error(error.message); }
    return data || [];
  } catch (e) { if (/groq_keys/i.test(e.message)) return []; throw e; }
}

export async function addGroqKey({ label, key }) {
  const sb = supabaseAdmin();
  if (!key || !String(key).trim()) throw new Error('A Groq key is required.');
  const { error } = await sb.from('groq_keys').insert({ label: (label || 'Key').slice(0, 60), key_enc: encrypt(String(key).trim()), active: true });
  if (error) throw new Error('Could not add the key: ' + error.message);
  return { ok: true };
}

export async function setGroqKeyActive(id, active) {
  const sb = supabaseAdmin();
  const { error } = await sb.from('groq_keys').update({ active: !!active }).eq('id', id);
  if (error) throw new Error('Could not update the key: ' + error.message);
  return { ok: true };
}

export async function deleteGroqKey(id) {
  const sb = supabaseAdmin();
  const { error } = await sb.from('groq_keys').delete().eq('id', id);
  if (error) throw new Error('Could not delete the key: ' + error.message);
  return { ok: true };
}
