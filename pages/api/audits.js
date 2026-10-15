import {
  authenticateRequest, getKeys, logActivity, supabaseAdmin
} from '../../lib/server';
import {
  AUDIT_RUBRIC_VERSION, AUDIT_THRESHOLDS, auditConnections, auditCsv, auditHtml,
  canManageAudits, canUseAudits, conversationTurns, deriveMetrics, fetchConversation,
  fetchIntercomAdmins, findConversationCandidates, getAuditAccessConfig,
  getAuditAgentConfig, getAuditModels, meaningfulAgentIds, parseConversationIds,
  redactConversation, restoreAuditTokens, retrieveAuditEvidence, runAuditModel, sampleCandidates,
  saveAuditAccessConfig, saveAuditAgentConfig, saveAuditModels
} from '../../lib/audits';

export const config = { maxDuration: 120 };

function checked(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

function publicJob(row) {
  const meta = row?.metadata || {};
  return {
    id: row?.id, createdAt: row?.created_at, createdBy: row?.user_email || row?.user_name || '',
    status: meta.status || (row?.success ? 'completed' : 'failed'), mode: meta.mode || 'sample',
    stage: meta.stage || '', total: Number(meta.total || 0), processed: Number(meta.processed || 0),
    completed: Number(meta.completed || 0), skipped: Number(meta.skipped || 0), failed: Number(meta.failed || 0),
    evaluations: Number(meta.evaluations || 0), currentConversationId: meta.currentConversationId || null,
    filters: meta.filters || {}, seed: meta.seed || '', rubricVersion: meta.rubricVersion || AUDIT_RUBRIC_VERSION,
    updatedAt: meta.updatedAt || row?.created_at, error: meta.error || '', directIds: meta.directIds || []
  };
}

function publicResult(row) {
  return { id: row.id, createdAt: row.created_at, ...(row.metadata || {}) };
}

async function loadJob(sb, id) {
  const data = checked(await sb.from('activity_logs').select('*').eq('id', id).eq('event_type', 'conversation_audit_job').maybeSingle(), 'Could not load the audit job');
  if (!data) throw new Error('Audit job not found.');
  return data;
}

async function loadResults(sb, jobId) {
  const rows = checked(await sb.from('activity_logs').select('id,created_at,metadata').eq('event_type', 'conversation_audit_result').contains('metadata', { jobId: String(jobId) }).order('created_at', { ascending: true }).order('id', { ascending: true }), 'Could not load audit results');
  return (rows || []).map(publicResult);
}

async function updateJob(sb, row, patch) {
  const metadata = { ...(row.metadata || {}), ...patch, updatedAt: new Date().toISOString() };
  const success = metadata.status === 'completed' ? true : metadata.status === 'failed' ? false : row.success;
  const data = checked(await sb.from('activity_logs').update({ metadata, success }).eq('id', row.id).select('*').single(), 'Could not save audit progress');
  return data;
}

function intercomLink(conversation) {
  return conversation?.links?.conversation_web || conversation?.links?.conversation || conversation?.conversation_web_url ||
    `https://app.intercom.com/a/inbox/_/inbox/search?query=${encodeURIComponent(conversation?.id || '')}`;
}

async function insertResult(sb, access, metadata, success = true) {
  const data = checked(await sb.from('activity_logs').insert({
    actor_role: access.role, session_id: access.sessionId, user_name: access.name, user_email: access.email,
    auth_provider: access.authProvider, event_type: 'conversation_audit_result', provider: metadata.provider || null,
    model: metadata.model || null, input_tokens: metadata.usage?.prompt_tokens ?? metadata.usage?.promptTokenCount ?? null,
    output_tokens: metadata.usage?.completion_tokens ?? metadata.usage?.candidatesTokenCount ?? null,
    success, metadata
  }).select('id,created_at,metadata').single(), 'Could not save the audit result');
  return publicResult(data);
}

async function createJob(req, access, sb, body) {
  const keys = await getKeys();
  if (!keys.intercomToken) throw new Error('Intercom is not connected. Add the API key in Admin first.');
  if (!(keys.geminiKeyPool || []).length) throw new Error('No Gemini keys are saved. Add at least one Gemini key in Admin first.');
  const directIds = parseConversationIds(body.conversationIds);
  const directInput = String(body.conversationIds || '').trim();
  if (directInput) {
    const rawIds = [...new Set(directInput.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
    const invalidIds = rawIds.filter((id) => !directIds.includes(id));
    if (invalidIds.length) throw new Error(`Check these conversation IDs: ${invalidIds.slice(0, 5).join(', ')}${invalidIds.length > 5 ? '…' : ''}`);
  }
  const seed = String(body.seed || cryptoRandom());
  let queue = []; let mode = 'sample';
  if (directInput) {
    mode = 'direct'; queue = directIds.map((id) => ({ id, targetAgentId: null, attempts: 0 }));
  } else {
    // A new installation has no saved allowlist yet. Use the same live Intercom
    // directory that bootstrap uses so a visibly enabled seeded agent is valid
    // on the very first audit run.
    const liveAdmins = await fetchIntercomAdmins(keys.intercomToken);
    const enabledIds = await getAuditAgentConfig(sb, liveAdmins);
    const requested = [...new Set((body.agentIds || []).map(String))].filter((id) => enabledIds.includes(id));
    if (!requested.length) throw new Error('Select at least one enabled Intercom agent.');
    const requestedSize = Math.max(1, Math.min(Number(body.sampleSize) || 10, 100));
    const candidates = await findConversationCandidates(keys.intercomToken, { agentIds: requested, from: body.from, to: body.to, maxPerAgent: Math.max(150, requestedSize * 4) });
    if (!candidates.length) throw new Error('Intercom returned no conversations for the selected agents and date range.');
    const previousRows = checked(await sb.from('activity_logs').select('metadata').eq('event_type', 'conversation_audit_result').eq('success', true).limit(5000), 'Could not check previous audits');
    const previouslyAudited = new Set((previousRows || []).map((row) => String(row.metadata?.conversationId || '')).filter(Boolean));
    const shuffled = sampleCandidates(candidates.filter((item) => !previouslyAudited.has(String(item.id))), candidates.length, seed);
    const admins = await fetchIntercomAdmins(keys.intercomToken);
    const eligible = [];
    for (let offset = 0; offset < shuffled.length && eligible.length < requestedSize; offset += 8) {
      const slice = shuffled.slice(offset, offset + 8);
      const fetched = await Promise.allSettled(slice.map((candidate) => fetchConversation(keys.intercomToken, candidate.id)));
      fetched.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const candidate = slice[index]; const turns = conversationTurns(result.value, admins);
        if (meaningfulAgentIds(turns).includes(String(candidate.agentId))) eligible.push(candidate);
      });
    }
    if (!eligible.length) throw new Error('No conversations with meaningful human-agent participation were found in this selection.');
    queue = eligible.slice(0, requestedSize).map((item) => ({ id: item.id, targetAgentId: item.agentId, attempts: 0 }));
  }
  const filters = mode === 'direct' ? { conversationIds: directIds } : { agentIds: body.agentIds || [], from: body.from || '', to: body.to || '', sampleSize: Math.max(1, Math.min(Number(body.sampleSize) || 10, 100)) };
  const metadata = {
    status: 'queued', mode, stage: 'Ready to fetch conversations', total: queue.length, processed: 0, completed: 0,
    skipped: 0, failed: 0, evaluations: 0, queue, filters, directIds, seed,
    rubricVersion: AUDIT_RUBRIC_VERSION, thresholds: AUDIT_THRESHOLDS, updatedAt: new Date().toISOString()
  };
  const id = await logActivity({ actorRole: access.role, sessionId: access.sessionId, userName: access.name, userEmail: access.email, authProvider: access.authProvider, eventType: 'conversation_audit_job', success: true, metadata }, { sb });
  if (!id) throw new Error('Could not create the audit job.');
  return publicJob(await loadJob(sb, id));
}

function cryptoRandom() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function processNext(access, sb, jobId) {
  let row = await loadJob(sb, jobId); let meta = row.metadata || {};
  if (meta.status === 'completed') return { job: publicJob(row), results: await loadResults(sb, jobId) };
  const queue = Array.isArray(meta.queue) ? meta.queue : [];
  const index = Number(meta.processed || 0);
  if (index >= queue.length) {
    row = await updateJob(sb, row, { status: 'completed', stage: 'Audit completed', currentConversationId: null });
    return { job: publicJob(row), done: true };
  }
  const item = queue[index];
  row = await updateJob(sb, row, { status: 'running', stage: 'Fetching the complete Intercom conversation', currentConversationId: item.id, error: '' });
  const keys = await getKeys();
  try {
    const [conversation, admins] = await Promise.all([fetchConversation(keys.intercomToken, item.id), fetchIntercomAdmins(keys.intercomToken)]);
    const turns = conversationTurns(conversation, admins);
    const meaningful = meaningfulAgentIds(turns);
    const targetIds = item.targetAgentId ? meaningful.filter((id) => id === String(item.targetAgentId)) : meaningful;
    if (!targetIds.length) {
      const reason = meaningful.length ? 'The selected agent did not provide a meaningful support response.' : 'No human agent provided a meaningful support response.';
      await insertResult(sb, access, { jobId: String(jobId), status: 'skipped', conversationId: String(item.id), conversationDate: conversation.created_at ? new Date(conversation.created_at * 1000).toISOString() : '', skipReason: reason, intercomLink: intercomLink(conversation), rubricVersion: AUDIT_RUBRIC_VERSION });
      row = await updateJob(sb, row, { processed: index + 1, skipped: Number(meta.skipped || 0) + 1, stage: 'Excluded a bot-only or non-participating conversation', currentConversationId: null });
      if (index + 1 >= queue.length) row = await updateJob(sb, row, { status: 'completed', stage: 'Audit completed' });
      return { job: publicJob(row), processed: { conversationId: item.id, status: 'skipped', reason } };
    }
    row = await updateJob(sb, row, { stage: 'Removing personal information before AI analysis' });
    const redacted = redactConversation(turns, conversation, admins);
    row = await updateJob(sb, row, { stage: 'Matching current FAQs, Notices and approved corrections' });
    const knowledge = await retrieveAuditEvidence(sb, redacted.transcript);
    const produced = [];
    for (const targetId of targetIds) {
      const agent = admins.find((candidate) => candidate.id === targetId) || { id: targetId, name: turns.find((turn) => turn.authorId === targetId)?.authorName || `Agent ${targetId}` };
      const metrics = deriveMetrics(conversation, turns, targetId);
      row = await updateJob(sb, row, { stage: `Scoring ${agent.name} with evidence`, currentConversationId: item.id });
      const model = await runAuditModel({ transcript: redacted.transcript, evidence: knowledge.evidence, metrics, targetAgent: { token: redacted.agentTokens[targetId] || '[TARGET_AGENT]', conversationAt: conversation.created_at ? new Date(conversation.created_at * 1000).toISOString() : '' } }, sb);
      const restoredAudit = restoreAuditTokens(model.audit, redacted.tokenReplacements);
      const result = await insertResult(sb, access, {
        jobId: String(jobId), status: 'completed', conversationId: String(item.id), conversationDate: conversation.created_at ? new Date(conversation.created_at * 1000).toISOString() : '',
        agentId: targetId, agentName: agent.name, intercomLink: intercomLink(conversation), audit: restoredAudit, metrics,
        evidence: knowledge.evidence.map(({ kind, id, title, url, postedAt }) => ({ kind, id, title, url, postedAt })), evidenceRetrievedAt: knowledge.retrievedAt,
        redactionCount: redacted.redactionCount, rubricVersion: AUDIT_RUBRIC_VERSION, provider: 'gemini', model: model.model,
        keyName: model.keyName, keyFingerprint: model.keyFingerprint, routeAttempts: model.attempts, usage: model.usage
      });
      produced.push(result);
    }
    const nextProcessed = index + 1;
    row = await updateJob(sb, row, {
      processed: nextProcessed, completed: Number(meta.completed || 0) + 1, evaluations: Number(meta.evaluations || 0) + produced.length,
      stage: nextProcessed >= queue.length ? 'Audit completed' : 'Saved securely — moving to the next conversation',
      status: nextProcessed >= queue.length ? 'completed' : 'running', currentConversationId: null
    });
    // The replacement map was scoped to this request and becomes unreachable here.
    redacted.ephemeralMap.clear();
    redacted.tokenReplacements.clear();
    return { job: publicJob(row), processed: { conversationId: item.id, status: 'completed', evaluations: produced.length }, results: produced };
  } catch (error) {
    const attempts = Number(item.attempts || 0) + 1;
    queue[index] = { ...item, attempts };
    if (attempts < 3 && /temporarily unavailable|too long|rate|quota|429|500|502|503|504|fetch/i.test(error.message)) {
      row = await updateJob(sb, row, { queue, status: 'paused', stage: `Waiting to retry conversation ${item.id}`, error: error.message, currentConversationId: item.id });
      return { job: publicJob(row), retryAfterMs: 3000, retrying: true };
    }
    await insertResult(sb, access, { jobId: String(jobId), status: 'failed', conversationId: String(item.id), error: error.message, rubricVersion: AUDIT_RUBRIC_VERSION }, false);
    const nextProcessed = index + 1;
    row = await updateJob(sb, row, { queue, processed: nextProcessed, failed: Number(meta.failed || 0) + 1, status: nextProcessed >= queue.length ? 'completed' : 'running', stage: nextProcessed >= queue.length ? 'Audit completed with failures' : 'Failure recorded — continuing safely', error: error.message, currentConversationId: null });
    return { job: publicJob(row), processed: { conversationId: item.id, status: 'failed', error: error.message } };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    const sb = supabaseAdmin();
    if (!(await canUseAudits(access, sb))) return res.status(403).json({ error: 'Conversation Audit access has not been granted to this account.' });
    const action = String(req.query.action || req.body?.action || 'bootstrap');

    if (req.method === 'GET' && action === 'export') {
      const job = publicJob(await loadJob(sb, req.query.jobId)); const results = await loadResults(sb, req.query.jobId);
      if (req.query.format === 'html') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="fundednext-audit-${job.id}.html"`);
        return res.status(200).send(auditHtml(job, results));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="fundednext-audit-${job.id}${req.query.detailed === '1' ? '-detailed' : ''}.csv"`);
      return res.status(200).send(auditCsv(results, req.query.detailed === '1'));
    }

    if (req.method === 'GET' && action === 'job') return res.json({ job: publicJob(await loadJob(sb, req.query.id)), results: await loadResults(sb, req.query.id) });

    if (req.method === 'GET' && action === 'bootstrap') {
      const keys = await getKeys();
      let admins = []; let intercomError = '';
      if (keys.intercomToken) try { admins = await fetchIntercomAdmins(keys.intercomToken); } catch (error) { intercomError = error.message; }
      const enabledAgentIds = await getAuditAgentConfig(sb, admins);
      const jobs = checked(await sb.from('activity_logs').select('*').eq('event_type', 'conversation_audit_job').order('created_at', { ascending: false }).limit(20), 'Could not load audit history');
      return res.json({
        access: { allowed: await canUseAudits(access, sb), canManage: canManageAudits(access), email: access.email || '', config: canManageAudits(access) ? await getAuditAccessConfig(sb) : undefined },
        agents: admins, enabledAgentIds, intercomError, models: await getAuditModels(sb),
        connection: { intercomConfigured: !!keys.intercomToken, geminiKeyCount: (keys.geminiKeyPool || []).length, geminiKeyNames: (keys.geminiKeyPool || []).map((item) => item.name) },
        thresholds: AUDIT_THRESHOLDS, rubricVersion: AUDIT_RUBRIC_VERSION, jobs: (jobs || []).map(publicJob)
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
    const body = req.body || {};
    if (action === 'health') return res.json({ health: await auditConnections() });
    if (action === 'create-job') return res.json({ job: await createJob(req, access, sb, body) });
    if (action === 'process-next') return res.json(await processNext(access, sb, body.jobId));
    if (action === 'sync-agents') {
      const keys = await getKeys(); if (!keys.intercomToken) throw new Error('Intercom is not connected.');
      const agents = await fetchIntercomAdmins(keys.intercomToken); const enabledAgentIds = await getAuditAgentConfig(sb, agents);
      return res.json({ agents, enabledAgentIds, syncedAt: new Date().toISOString() });
    }
    if (action === 'save-agents') {
      if (!canManageAudits(access)) return res.status(403).json({ error: 'Admin access is required to change the agent dropdown.' });
      return res.json({ enabledAgentIds: await saveAuditAgentConfig(body.agentIds, sb) });
    }
    if (action === 'save-access') {
      if (!canManageAudits(access)) return res.status(403).json({ error: 'Admin access is required to change Audit access.' });
      return res.json({ access: await saveAuditAccessConfig(body.emails, sb) });
    }
    if (action === 'save-models') {
      if (!canManageAudits(access)) return res.status(403).json({ error: 'Admin access is required to change the audit model chain.' });
      return res.json({ models: await saveAuditModels(body.models, sb) });
    }
    return res.status(400).json({ error: 'Unknown audit action.' });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Audit request failed.' });
  }
}
