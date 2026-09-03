// ============================================================================
// lib/notices.js
// Backend logic for the Notices layer. Reuses helpers from ./server.
// Additive — does not modify the live FAQ path.
// ============================================================================
import { supabaseAdmin, getKeys, openaiEmbed, openaiChatDetailed } from './server';

// ---- Access gate ----------------------------------------------------------
// Allowlist lives in settings key 'notice_lab_emails' (comma-separated), and
// falls back to the NOTICE_LAB_EMAILS env var, then to your email.
export async function noticeAllowlist(sb = supabaseAdmin()) {
  try {
    const { data } = await sb.from('settings').select('value').eq('key', 'notice_lab_emails').maybeSingle();
    if (data?.value && data.value.trim()) {
      return data.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
  } catch (e) { /* ignore */ }
  const env = process.env.NOTICE_LAB_EMAILS || 'faiyaz@nextventures.io';
  return env.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
export async function isNoticeLabUser(access, sb = supabaseAdmin()) {
  return noticesAccess(access, sb);
}

// ---- Notices access model (Team Access controls) --------------------------
// Sources of truth (settings): notices_enabled (global on/off), notices_domain_all
// (all @nextventures.io users), notices_access_emails (explicit allowlist).
// Falls back to the older notice_lab_emails row if present, then to your email.
export async function getNoticesAccessConfig(sb = supabaseAdmin()) {
  let domainAll = false, emails = null, enabled = true;
  try {
    const { data } = await sb.from('settings').select('key,value')
      .in('key', ['notices_domain_all', 'notices_access_emails', 'notices_enabled', 'notice_lab_emails']);
    let legacy = null;
    for (const row of (data || [])) {
      const v = String(row.value == null ? '' : row.value).trim();
      if (row.key === 'notices_domain_all') domainAll = v.toLowerCase() === 'true';
      else if (row.key === 'notices_enabled') enabled = v.toLowerCase() !== 'false';
      else if (row.key === 'notices_access_emails' && v) emails = v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
      else if (row.key === 'notice_lab_emails' && v) legacy = v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    }
    if (!emails) emails = legacy;
  } catch (e) { /* ignore */ }
  if (!emails) emails = ['faiyaz@nextventures.io'];
  return { domainAll, emails, enabled };
}

export async function setNoticesAccessConfig({ domainAll, emails }, sb = supabaseAdmin()) {
  const rows = [];
  if (typeof domainAll === 'boolean') rows.push({ key: 'notices_domain_all', value: domainAll ? 'true' : 'false' });
  if (Array.isArray(emails)) rows.push({ key: 'notices_access_emails', value: emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean).join(',') });
  for (const r of rows) { const { error } = await sb.from('settings').upsert(r); if (error) throw new Error(error.message); }
  return { ok: true };
}

export async function noticesAccess(access, sb = supabaseAdmin()) {
  if (!access?.email) return false;
  const { domainAll, emails, enabled } = await getNoticesAccessConfig(sb);
  if (!enabled) return false;
  const email = String(access.email).toLowerCase();
  if (emails.includes(email)) return true;
  if (domainAll && email.endsWith('@nextventures.io')) return true;
  return false;
}

// ---- AI extraction for the paste path -------------------------------------
export async function extractNoticeFromText({ text, source_url, posted_by, posted_at }, { openaiKey, chatModel } = {}) {
  if (!openaiKey) { const k = await getKeys(); openaiKey = k.openaiKey; chatModel = chatModel || k.chatModel; }
  if (!openaiKey) throw new Error('OpenAI key is not set.');
  const sys = 'You convert an internal FundedNext CEx notice into structured JSON for a support knowledge base. ' +
    'Output ONLY valid JSON: an array of entry objects, no prose. Split into multiple entries ONLY if the notice states independent facts on different topics. ' +
    'Each entry: {"title","category","topic_key","product","model","change_type","answer_text","requires_escalation","escalation","keywords"}. ' +
    'product is "cfd" | "futures" | "both". model is a model slug or "all". change_type is "new" | "replace" | "amend_add" | "clarify". ' +
    'category MUST be one of: KYC & Verification, Payouts & Withdrawals, Product Models & Rules, Risk & Clarity Card, Payments (Pay-in), Competitions, Offers & Coupons, Platform & Account Actions, Fees & Refunds, Name & Profile, Tax, Inactivity & Allocation. ' +
    'topic_key is a short dot.namespaced key (e.g. kyc.uk.documents, payout.bank_transfer.brand_promise, product.<model>.rules). ' +
    'answer_text must be customer-ready and factual with NO internal routing. Put any "escalate to X" routing ONLY inside escalation {target,channel,reason,condition}, never in answer_text. escalation is null when not needed. keywords is a short array.';
  const completion = await openaiChatDetailed(openaiKey, chatModel || 'gpt-4o', [
    { role: 'system', content: sys },
    { role: 'user', content: 'NOTICE TEXT:\n' + String(text || '') }
  ]);
  let raw = String(completion.content || '').trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { const m = raw.match(/\[[\s\S]*\]/); arr = m ? JSON.parse(m[0]) : []; }
  if (!Array.isArray(arr)) arr = [arr];
  const mid = (String(source_url || '').match(/\/t\/(\d+)/) || [])[1] || String(Date.now());
  const slug = (x) => String(x || 'entry').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  return arr.map((e, i) => ({
    entry_id: mid + '__' + (slug(e.topic_key) || i),
    clickup_message_id: mid,
    source_url: source_url || null,
    title: e.title || '(notice)',
    category: e.category || null,
    topic_key: e.topic_key || null,
    product: ['cfd', 'futures', 'both'].includes(e.product) ? e.product : 'both',
    model: e.model || 'all',
    posted_by: posted_by || null,
    posted_by_id: null,
    posted_at: posted_at || new Date().toISOString(),
    status: 'active',
    change_type: ['new', 'replace', 'amend_add', 'clarify'].includes(e.change_type) ? e.change_type : 'new',
    supersedes: [], superseded_by: null,
    requires_escalation: !!e.requires_escalation,
    escalation: e.escalation || null,
    source_type: 'notice', parent_entry_id: null,
    answer_text: e.answer_text || '',
    keywords: Array.isArray(e.keywords) ? e.keywords : [],
    raw_excerpt: String(text || '').slice(0, 1000)
  }));
}

// ---- Import from the RAG file ---------------------------------------------
export async function importNoticesRag(ragJson, sb = supabaseAdmin()) {
  const entries = Array.isArray(ragJson?.entries) ? ragJson.entries : [];
  if (!entries.length) throw new Error('No "entries" array found in the RAG file.');
  const rows = entries.map((e) => ({
    entry_id: e.entry_id,
    clickup_message_id: e.clickup_message_id || null,
    source_url: e.source_url || null,
    title: e.title || null,
    category: e.category || null,
    topic_key: e.topic_key || null,
    product: e.product || 'both',
    model: e.model || 'all',
    posted_by: e.posted_by || null,
    posted_by_id: e.posted_by_id || null,
    posted_at: e.posted_at || null,
    status: e.status || 'active',
    change_type: e.change_type || 'new',
    supersedes: e.supersedes || [],
    superseded_by: e.superseded_by || null,
    availability: e.availability || null,
    effective_from: e.effective_from || null,
    effective_until: e.effective_until || null,
    requires_escalation: !!e.requires_escalation,
    escalation: e.escalation || null,
    source_type: e.source_type || 'notice',
    parent_entry_id: e.parent_entry_id || null,
    thread_reply_id: e.thread_reply_id || null,
    answered_by: e.answered_by || null,
    review_flag: e.review_flag || null,
    answer_text: e.answer_text || null,
    keywords: e.keywords || [],
    raw_excerpt: e.raw_excerpt || null,
    updated_at: new Date().toISOString()
  })).filter((r) => r.entry_id);
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await sb.from('notices').upsert(rows.slice(i, i + 100));
    if (error) throw new Error('Import failed: ' + error.message);
  }
  return { imported: rows.length };
}

// ---- Deterministic reconcile (supersession + expiry) ----------------------
export async function reconcileNotices(sb = supabaseAdmin()) {
  const { data, error } = await sb.from('notices').select('*');
  if (error) throw new Error('Reconcile read failed: ' + error.message);
  const all = data || [];
  const now = Date.now();
  const updates = new Map(); // entry_id -> {status, superseded_by}

  // Expire time-bound entries whose effective_until date has passed
  for (const e of all) {
    if (e.effective_until && e.effective_until !== 'until_further_notice') {
      const t = Date.parse(e.effective_until);
      if (!isNaN(t) && t < now && e.status !== 'expired') updates.set(e.entry_id, { status: 'expired', superseded_by: e.superseded_by || null });
    }
  }

  // Supersession within (topic_key, product, model). amend_add & clarify are kept.
  const groups = {};
  for (const e of all) {
    if (e.source_type === 'thread_reply') continue;
    if (!['new', 'replace'].includes(e.change_type)) continue;
    if ((updates.get(e.entry_id)?.status || e.status) === 'expired') continue;
    const k = `${e.topic_key}||${e.product}||${e.model}`;
    (groups[k] = groups[k] || []).push(e);
  }
  for (const k of Object.keys(groups)) {
    const g = groups[k].sort((a, b) => (Date.parse(b.posted_at || 0) || 0) - (Date.parse(a.posted_at || 0) || 0));
    for (let i = 0; i < g.length; i++) {
      const e = g[i];
      const desired = i === 0 ? 'active' : 'superseded';
      const supBy = i === 0 ? null : g[0].entry_id;
      const cur = updates.get(e.entry_id)?.status || e.status;
      if (cur !== 'expired' && (e.status !== desired || e.superseded_by !== supBy)) {
        updates.set(e.entry_id, { status: desired, superseded_by: supBy });
      }
    }
  }

  for (const [entry_id, u] of updates) {
    const { error: uErr } = await sb.from('notices')
      .update({ status: u.status, superseded_by: u.superseded_by, updated_at: new Date().toISOString() })
      .eq('entry_id', entry_id);
    if (uErr) throw new Error('Reconcile update failed: ' + uErr.message);
  }
  return { updated: updates.size };
}

// ---- Re-embed active entries into notice_chunks ---------------------------
export async function reindexNotices(sb = supabaseAdmin(), { openaiKey } = {}) {
  if (!openaiKey) { const k = await getKeys(); openaiKey = k.openaiKey; }
  if (!openaiKey) throw new Error('OpenAI key is not set — add it in the API vault first.');

  const { data, error } = await sb.from('notices').select('*').eq('status', 'active');
  if (error) throw new Error('Reindex read failed: ' + error.message);
  const active = (data || []).filter((e) => !e.review_flag); // review-flagged are held

  { const { error: delErr } = await sb.from('notice_chunks').delete().gte('id', 0);
    if (delErr) throw new Error('Could not clear notice_chunks: ' + delErr.message); }

  let count = 0;
  const BATCH = 64;
  for (let i = 0; i < active.length; i += BATCH) {
    const slice = active.slice(i, i + BATCH);
    const texts = slice.map((e) => `${e.title || ''}\n${e.answer_text || ''}\n${(e.keywords || []).join(' ')}`.trim());
    const vecs = await openaiEmbed(openaiKey, texts);
    const rows = slice.map((e, j) => ({
      article_id: e.entry_id,
      article_title: e.title || '(notice)',
      article_url: e.source_url || '',
      chunk_index: 0,
      content: `${e.title || ''}. ${e.answer_text || ''}`.trim(),
      embedding: vecs[j]
    }));
    const { error: insErr } = await sb.from('notice_chunks').insert(rows);
    if (insErr) throw new Error('Reindex insert failed: ' + insErr.message);
    count += rows.length;
  }
  try { await sb.from('settings').upsert({ key: 'notices_indexed_at', value: new Date().toISOString() }); } catch (e) { /* ignore */ }
  return { indexed: count, at: new Date().toISOString() };
}

// ---- Retrieval used by /api/search-next -----------------------------------
export async function retrieveNotices(sb, { openaiKey, question, product = 'both', model = 'all', limit = 6 }) {
  if (!openaiKey) return { matches: [], escalations: [] };
  let vec;
  try { const v = await openaiEmbed(openaiKey, [question]); vec = v[0]; } catch (e) { return { matches: [], escalations: [] }; }
  const res = await sb.rpc('match_notice_chunks', { query_embedding: vec, match_threshold: 0.14, match_count: 20 });
  if (res.error || !res.data?.length) return { matches: [], escalations: [] };

  const ids = [...new Set(res.data.map((r) => r.article_id))];
  const { data: metas } = await sb.from('notices').select('*').in('entry_id', ids).eq('status', 'active');
  const metaById = Object.fromEntries((metas || []).map((m) => [m.entry_id, m]));

  const scored = res.data
    .map((r) => ({ ...r, meta: metaById[r.article_id] }))
    .filter((r) => r.meta) // active only
    .filter((r) => {
      const p = r.meta.product || 'both';
      if (product !== 'both' && p !== 'both' && p !== product) return false;
      const m = r.meta.model || 'all';
      if (model !== 'all' && m !== 'all' && m !== model) return false;
      return true;
    });

  const seen = new Set();
  const matches = [];
  for (const r of scored) {
    if (seen.has(r.article_id)) continue;
    seen.add(r.article_id);
    matches.push(r);
    if (matches.length >= limit) break;
  }
  const escalations = matches
    .filter((m) => m.meta.requires_escalation && m.meta.escalation)
    .map((m) => ({ ...m.meta.escalation, from: m.meta.title, source_url: m.meta.source_url }));
  return { matches, escalations };
}

// ---- Admin list / status / manual save ------------------------------------
export async function listNotices(sb = supabaseAdmin()) {
  const { data, error } = await sb.from('notices').select('*').order('posted_at', { ascending: false }).limit(2000);
  if (error) throw new Error(error.message);
  return data || [];
}
export async function setNoticeStatus(entry_id, status, sb = supabaseAdmin()) {
  const { error } = await sb.from('notices').update({ status, updated_at: new Date().toISOString() }).eq('entry_id', entry_id);
  if (error) throw new Error(error.message);
  return { ok: true };
}
export async function saveNoticeEntry(entry, sb = supabaseAdmin()) {
  const row = { ...entry, updated_at: new Date().toISOString() };
  const { error } = await sb.from('notices').upsert(row);
  if (error) throw new Error(error.message);
  return { ok: true };
}

// ---- Feature flag: is the notices layer active in the main assistant? ------
// Default ON. To disable (e.g. on production until you're ready), add a
// settings row: key 'notices_enabled', value 'false'.
export async function noticesEnabledFlag(sb = supabaseAdmin()) {
  try {
    const { data } = await sb.from('settings').select('value').eq('key', 'notices_enabled').maybeSingle();
    if (data && typeof data.value === 'string') return data.value.trim().toLowerCase() !== 'false';
  } catch (e) { /* ignore */ }
  return true;
}
