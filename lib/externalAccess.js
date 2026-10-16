import crypto from 'crypto';
import { logActivity, supabaseAdmin } from './server';

const SETTING_KEY = 'external_api_keys_v1';
export const EXTERNAL_SCOPES = [
  'chatbot:test', 'audit:run', 'audit:read', 'diagnostics:read',
  'knowledge:read-metadata', 'transcripts:read-redacted'
];
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 90;

function digest(value) {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error('ENCRYPTION_SECRET is missing. Add it in Vercel.');
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || '')); const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function readRecords(sb = supabaseAdmin()) {
  const { data, error } = await sb.from('settings').select('value').eq('key', SETTING_KEY).maybeSingle();
  if (error) throw new Error(`Could not read developer keys: ${error.message}`);
  try { const parsed = JSON.parse(data?.value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

async function writeRecords(records, sb = supabaseAdmin()) {
  const { error } = await sb.from('settings').upsert({ key: SETTING_KEY, value: JSON.stringify(records) }, { onConflict: 'key' });
  if (error) throw new Error(`Could not save developer keys: ${error.message}`);
}

function publicRecord(item) {
  return {
    id: item.id, name: item.name, prefix: item.prefix, scopes: item.scopes || [],
    createdAt: item.createdAt, expiresAt: item.expiresAt, revokedAt: item.revokedAt || null,
    lastUsedAt: item.lastUsedAt || null, status: item.revokedAt ? 'revoked' : Date.parse(item.expiresAt) <= Date.now() ? 'expired' : 'active'
  };
}

export async function listExternalApiKeys(sb = supabaseAdmin()) {
  return (await readRecords(sb)).map(publicRecord).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function createExternalApiKey({ name, scopes = EXTERNAL_SCOPES, expiresInDays = 7, ownerEmail = '', ownerName = '' }, sb = supabaseAdmin()) {
  const cleanName = String(name || 'Codex testing').trim().slice(0, 80) || 'Codex testing';
  const cleanScopes = [...new Set((scopes || []).map(String).filter((scope) => EXTERNAL_SCOPES.includes(scope)))];
  if (!cleanScopes.length) throw new Error('Select at least one developer API permission.');
  const days = Math.max(1, Math.min(Number(expiresInDays) || 7, 30));
  const id = crypto.randomBytes(10).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const plaintext = `fnx_${id}_${secret}`;
  const now = new Date();
  const record = {
    id, name: cleanName, prefix: `fnx_${id.slice(0, 8)}`, hash: digest(plaintext), scopes: cleanScopes,
    ownerEmail: String(ownerEmail || '').trim().toLowerCase(), ownerName: String(ownerName || '').trim().slice(0, 120),
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + days * 86400000).toISOString(),
    revokedAt: null, lastUsedAt: null
  };
  const records = await readRecords(sb); records.push(record); await writeRecords(records.slice(-50), sb);
  return { key: plaintext, record: publicRecord(record) };
}

export async function revokeExternalApiKey(id, sb = supabaseAdmin()) {
  const records = await readRecords(sb); let found = false;
  const updated = records.map((item) => {
    if (item.id !== String(id) || item.revokedAt) return item;
    found = true; return { ...item, revokedAt: new Date().toISOString() };
  });
  if (!found) throw new Error('Developer API key not found or already revoked.');
  await writeRecords(updated, sb); return updated.map(publicRecord).find((item) => item.id === String(id));
}

function bearer(req) {
  const authorization = String(req?.headers?.authorization || '');
  const match = authorization.match(/^Bearer\s+(fnx_[A-Za-z0-9_-]+)$/i);
  return match?.[1] || String(req?.headers?.['x-fn-api-key'] || '').trim();
}

export async function authenticateExternalApiKey(req, requiredScope = null, sb = supabaseAdmin()) {
  const plaintext = bearer(req); if (!plaintext?.startsWith('fnx_')) return null;
  const hash = digest(plaintext); const records = await readRecords(sb);
  const record = records.find((item) => safeEqual(item.hash, hash));
  if (!record || record.revokedAt || Date.parse(record.expiresAt) <= Date.now()) {
    const error = new Error('Developer API key is invalid, expired, or revoked.'); error.status = 401; throw error;
  }
  if (requiredScope && !(record.scopes || []).includes(requiredScope)) {
    const error = new Error(`Developer API key lacks the ${requiredScope} permission.`); error.status = 403; throw error;
  }
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count, error: countError } = await sb.from('activity_logs').select('id', { count: 'exact', head: true })
    .eq('event_type', 'external_api_request').gte('created_at', since).contains('metadata', { keyId: record.id });
  if (countError) throw new Error(`Developer API rate-limit check failed: ${countError.message}`);
  if (Number(count || 0) >= RATE_MAX) { const error = new Error('Developer API rate limit reached. Retry after one minute.'); error.status = 429; throw error; }
  const now = new Date().toISOString(); record.lastUsedAt = now; await writeRecords(records, sb);
  const access = {
    role: 'admin', sessionId: `external:${record.id}`, name: record.ownerName || record.name,
    // Keys created before owner identity was stored were available only to the
    // original Master/Faiyaz control. Preserve their Notices-enabled test scope.
    email: record.ownerEmail || 'faiyaz@nextventures.io', authProvider: 'external_api', external: true, externalKeyId: record.id, scopes: record.scopes || []
  };
  await logActivity({
    actorRole: 'admin', sessionId: access.sessionId, userName: record.name, userEmail: null,
    authProvider: 'external_api', eventType: 'external_api_request', success: true,
    metadata: { keyId: record.id, keyPrefix: record.prefix, method: req.method, path: String(req.url || '').slice(0, 300), requiredScope }
  }, { sb });
  return access;
}

export function hasExternalScope(access, scope) {
  return !!access?.external && Array.isArray(access.scopes) && access.scopes.includes(scope);
}
