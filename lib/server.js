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

const DEFAULT_MODEL = 'gpt-5.6-luna';
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
  return {
    intercomToken: encIntercom ? tryDecrypt(encIntercom) : null,
    openaiKey: encOpenai ? tryDecrypt(encOpenai) : null,
    groqKey: encGroq ? tryDecrypt(encGroq) : null,
    chatModel: model || DEFAULT_MODEL,
    chatProvider: provider === 'groq' ? 'groq' : DEFAULT_PROVIDER,
    smartRetrieval: smart == null ? true : smart === 'true'
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
  return {
    intercomSet: !!encIntercom,
    openaiSet: !!encOpenai,
    groqSet: !!encGroq,
    chatModel: model || DEFAULT_MODEL,
    chatProvider: provider === 'groq' ? 'groq' : DEFAULT_PROVIDER,
    chatPrompt: prompt && prompt.trim() ? prompt : DEFAULT_PROMPT,
    smartRetrieval: smart == null ? true : smart === 'true',
    allowedGoogleDomains: allowedGoogleDomains || '',
    googleAuthConfigured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  };
}

export async function saveKeys({ intercomToken, openaiKey, groqKey, chatModel, chatProvider, chatPrompt, allowedGoogleDomains, smartRetrieval }) {
  const sb = supabaseAdmin();
  const rows = [];
  if (typeof smartRetrieval === 'boolean') rows.push({ key: 'smart_retrieval', value: smartRetrieval ? 'true' : 'false' });
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
    match: ['cycle', 'cycles', 'trading cycle', 'payout cycle', 'biweekly', 'bi-weekly', 'every 14', 'every 5', 'schedule', 'frequency', 'how often'],
    expand: ['trading cycle length by account type', 'how often payouts occur after first withdrawal']
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
  const key = provider === 'groq' ? groqKey : openaiKey;
  const baseUrl = provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
  if (!key) return null;
  const sys =
    'You prepare noisy customer-support questions for a FundedNext FAQ search. ' +
    'Return STRICT JSON only, no prose, with keys: ' +
    '"clear" (the question rewritten clearly, fixing typos/grammar; keep the original meaning, do not invent an account type), ' +
    '"queries" (array of 2-4 short search phrases covering each plausible meaning), ' +
    '"ambiguous" (true if the question could mean two genuinely different things), ' +
    '"interpretations" (array of 1-3 short labels for the distinct meanings). ' +
    'FundedNext context: a payout question may mean payout-cycle eligibility timing, the 24-hour processing Brand Promise, or withdrawal method speed — treat these as different meanings.';
  try {
    const { content } = await openaiChatDetailed(key, model, [
      { role: 'system', content: sys },
      { role: 'user', content: String(question).slice(0, 500) }
    ], baseUrl);
    const jsonText = String(content).replace(/```json|```/g, '').trim();
    const start = jsonText.indexOf('{'); const end = jsonText.lastIndexOf('}');
    if (start < 0 || end < 0) return null;
    const parsed = JSON.parse(jsonText.slice(start, end + 1));
    return {
      clear: typeof parsed.clear === 'string' ? parsed.clear.slice(0, 400) : '',
      queries: Array.isArray(parsed.queries) ? parsed.queries.filter((q) => typeof q === 'string').slice(0, 4) : [],
      ambiguous: !!parsed.ambiguous,
      interpretations: Array.isArray(parsed.interpretations) ? parsed.interpretations.filter((s) => typeof s === 'string').slice(0, 3) : []
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
  if (!error) {
    try {
      await sb.from('settings').upsert([
        { key: 'last_auto_sync_at', value: finishedAt.toISOString() },
        { key: 'last_sync_summary', value: JSON.stringify({ at: finishedAt.toISOString(), trigger, status, changed: agg.articlesChanged, indexed: agg.articlesIndexed, deleted: agg.articlesDeleted }) }
      ]);
    } catch { /* ignore */ }
  }
  return { done, status, error, ...agg, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() };
}

const AUTO_SYNC_INTERVALS = [2, 3, 4, 6, 8, 12, 24];

export async function getAutoSyncConfig(sb = supabaseAdmin()) {
  const enabled = (await getRaw(sb, 'auto_sync_enabled')) === 'true';
  const rawInterval = parseInt(await getRaw(sb, 'auto_sync_interval_hours'), 10);
  const intervalHours = AUTO_SYNC_INTERVALS.includes(rawInterval) ? rawInterval : 6;
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
    const h = AUTO_SYNC_INTERVALS.includes(Number(intervalHours)) ? Number(intervalHours) : 6;
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
