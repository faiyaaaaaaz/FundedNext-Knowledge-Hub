import {
  authenticateRequest, getKeys, logActivity, supabaseAdmin
} from '../../lib/server';
import {
  AUDIT_RUBRIC_VERSION, AUDIT_THRESHOLDS, auditConnections, auditCsv, auditHtml,
  canManageAudits, canUseAudits, conversationTurns, deriveMetrics, fetchConversation,
  fetchIntercomAdmins, findConversationCandidates, getAuditAccessConfig, getAuditPermission, getAuditSelfAccessConfig,
  getAuditAgentConfig, getAuditLevel2Config, getAuditModels, meaningfulAgentIds, parseConversationIds,
  redactConversation, restoreAuditTokens, retrieveAuditEvidence, runAuditModel, sampleCandidates,
  saveAuditAccessConfig, saveAuditAgentConfig, saveAuditLevel2Config, saveAuditModels, saveAuditSelfAccessConfig
} from '../../lib/audits';
import {
  authenticateExternalApiKey, createExternalApiKey, hasExternalScope,
  listExternalApiKeys, revokeExternalApiKey, EXTERNAL_SCOPES
} from '../../lib/externalAccess';

export const config = { maxDuration: 120 };

function checked(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

function publicJob(row, enrichment = {}) {
  const meta = row?.metadata || {};
  const agentNames = [...new Set([...(meta.agentNames || []), ...(enrichment.agentNames || [])].map((item) => String(item || '').trim()).filter(Boolean))];
  return {
    id: row?.id, createdAt: row?.created_at, createdBy: row?.user_email || row?.user_name || '',
    status: meta.status || (row?.success ? 'completed' : 'failed'), mode: meta.mode || 'sample',
    stage: meta.stage || '', total: Number(meta.total || 0), processed: Number(meta.processed || 0),
    completed: Number(meta.completed || 0), skipped: Number(meta.skipped || 0), failed: Number(meta.failed || 0),
    evaluations: Number(meta.evaluations || 0), currentConversationId: meta.currentConversationId || null,
    pauseRequested: !!meta.pauseRequested, cancelRequested: !!meta.cancelRequested,
    filters: meta.filters || {}, seed: meta.seed || '', rubricVersion: meta.rubricVersion || AUDIT_RUBRIC_VERSION,
    updatedAt: meta.updatedAt || row?.created_at, error: meta.error || '', directIds: meta.directIds || [], agentNames,
    scoreSummary: enrichment.scoreSummary || meta.scoreSummary || null
  };
}

function fileSafe(value) {
  return String(value || '').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'agent';
}

function auditFileBase(job, results = []) {
  const names = [...new Set([...(job.agentNames || []), ...results.map((item) => item.agentName)].map((item) => String(item || '').trim()).filter(Boolean))];
  const agent = names.length > 1 ? `${fileSafe(names[0])}-plus-${names.length - 1}` : fileSafe(names[0] || 'agent');
  return `${agent}-audit-${job.id}`;
}

function publicResult(row) {
  return { id: row.id, createdAt: row.created_at, ...(row.metadata || {}) };
}

async function loadJob(sb, id) {
  const data = checked(await sb.from('activity_logs').select('*').eq('id', id).eq('event_type', 'conversation_audit_job').maybeSingle(), 'Could not load the audit job');
  if (!data) throw new Error('Audit job not found.');
  return data;
}

async function loadDisputes(sb, resultIds = []) {
  if (!resultIds.length) return new Map();
  const rows = checked(await sb.from('activity_logs').select('id,created_at,user_name,user_email,metadata').eq('event_type', 'conversation_audit_dispute').in('metadata->>resultId', resultIds.map(String)).order('created_at', { ascending: false }).limit(5000), 'Could not load audit disputes');
  const byResult = new Map();
  for (const row of rows || []) {
    const resultId = String(row.metadata?.resultId || '');
    if (!resultId || byResult.has(resultId)) continue;
    byResult.set(resultId, { id: row.id, createdAt: row.created_at, submittedBy: row.user_name || row.user_email || '', submittedByEmail: row.user_email || '', ...(row.metadata || {}) });
  }
  return byResult;
}

async function loadResults(sb, jobId) {
  const rows = checked(await sb.from('activity_logs').select('id,created_at,metadata').eq('event_type', 'conversation_audit_result').contains('metadata', { jobId: String(jobId) }).order('created_at', { ascending: true }).order('id', { ascending: true }), 'Could not load audit results');
  const disputes = await loadDisputes(sb, (rows || []).map((row) => String(row.id)));
  return (rows || []).map((row) => ({ ...publicResult(row), dispute: disputes.get(String(row.id)) || null }));
}

function resultOwnedBy(result, email, agentIds = []) {
  const normalized = String(email || '').trim().toLowerCase();
  return (!!normalized && String(result?.agentEmail || '').trim().toLowerCase() === normalized) || agentIds.includes(String(result?.agentId || ''));
}

async function auditIdentity(access, permission, sb) {
  if (permission !== 'self') return { agentIds: [], admins: [] };
  const keys = await getKeys();
  const admins = keys.intercomToken ? await fetchIntercomAdmins(keys.intercomToken) : [];
  return { admins, agentIds: admins.filter((agent) => String(agent.email || '').toLowerCase() === String(access.email || '').toLowerCase()).map((agent) => String(agent.id)) };
}

function requireRunner(permission, access) {
  if (!access.external && !['manager', 'auditor'].includes(permission)) {
    const error = new Error('Your My Audits access lets you review and dispute your own results, but does not allow running audits.'); error.status = 403; throw error;
  }
}

async function resultsWithLiveTranscripts(results, intercomToken) {
  if (!intercomToken) return results;
  const admins = await fetchIntercomAdmins(intercomToken);
  const completed = results.filter((item) => item.status === 'completed' && item.conversationId);
  const turnsByConversation = new Map();
  for (let offset = 0; offset < completed.length; offset += 10) {
    const batch = completed.slice(offset, offset + 10);
    const fetched = await Promise.allSettled(batch.map((item) => fetchConversation(intercomToken, item.conversationId)));
    fetched.forEach((entry, index) => {
      if (entry.status !== 'fulfilled') return;
      const turns = conversationTurns(entry.value, admins).map((turn) => ({
        id: turn.id, at: turn.at, kind: turn.kind, authorName: turn.authorName,
        body: turn.body, partType: turn.partType
      }));
      turnsByConversation.set(String(batch[index].conversationId), turns);
    });
  }
  return results.map((result) => ({ ...result, reportTurns: turnsByConversation.get(String(result.conversationId)) || [] }));
}

async function updateJob(sb, row, patch) {
  const latest = checked(await sb.from('activity_logs').select('*').eq('id', row.id).eq('event_type', 'conversation_audit_job').single(), 'Could not refresh audit controls');
  const metadata = { ...(latest.metadata || {}), ...patch, updatedAt: new Date().toISOString() };
  const success = metadata.status === 'completed' ? true : metadata.status === 'failed' ? false : latest.success;
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
  let queue = []; let mode = 'sample'; let agentNames = [];
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
    agentNames = requested.map((id) => liveAdmins.find((agent) => String(agent.id) === String(id))?.name).filter(Boolean);
    const requestedSize = Math.max(1, Math.min(Number(body.sampleSize) || 10, 100));
    const candidates = await findConversationCandidates(keys.intercomToken, { agentIds: requested, from: body.from, to: body.to, maxPerAgent: Math.max(150, requestedSize * 4) });
    if (!candidates.length) throw new Error('Intercom returned no conversations for the selected agents and date range.');
    const previousRows = checked(await sb.from('activity_logs').select('metadata').eq('event_type', 'conversation_audit_result').eq('success', true).limit(5000), 'Could not check previous audits');
    const previouslyAudited = new Set((previousRows || []).map((row) => {
      const conversationId = String(row.metadata?.conversationId || ''); const agentId = String(row.metadata?.agentId || '');
      return conversationId && agentId ? `${conversationId}:${agentId}` : conversationId;
    }).filter(Boolean));
    const available = candidates.filter((item) => !previouslyAudited.has(`${item.id}:${item.agentId}`) && !previouslyAudited.has(String(item.id)));
    const shuffled = sampleCandidates(available, available.length, seed);
    const admins = await fetchIntercomAdmins(keys.intercomToken);
    const eligible = []; const comparisonPoolSize = Math.min(shuffled.length, Math.max(requestedSize * 4, 40));
    for (let offset = 0; offset < comparisonPoolSize; offset += 8) {
      const slice = shuffled.slice(offset, offset + 8);
      const fetched = await Promise.allSettled(slice.map((candidate) => fetchConversation(keys.intercomToken, candidate.id)));
      fetched.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const candidate = slice[index]; const turns = conversationTurns(result.value, admins);
        if (!meaningfulAgentIds(turns).includes(String(candidate.agentId))) return;
        const agentMessageCount = turns.filter((turn) => turn.kind === 'agent' && turn.authorId === String(candidate.agentId) && turn.body).length;
        eligible.push({ ...candidate, agentMessageCount });
      });
    }
    if (!eligible.length) throw new Error('No conversations with meaningful human-agent participation were found in this selection.');
    eligible.sort((a, b) => b.agentMessageCount - a.agentMessageCount || Number(b.createdAt || 0) - Number(a.createdAt || 0));
    queue = eligible.slice(0, requestedSize).map((item) => ({ id: item.id, targetAgentId: item.agentId, agentMessageCount: item.agentMessageCount, attempts: 0 }));
  }
  const filters = mode === 'direct' ? { conversationIds: directIds } : { agentIds: body.agentIds || [], from: body.from || '', to: body.to || '', sampleSize: Math.max(1, Math.min(Number(body.sampleSize) || 10, 100)), selectionStrategy: 'highest_target_agent_message_count' };
  const metadata = {
    status: 'queued', mode, stage: 'Ready to fetch conversations', total: queue.length, processed: 0, completed: 0,
    skipped: 0, failed: 0, evaluations: 0, queue, filters, directIds, seed, pauseRequested: false, cancelRequested: false,
    rubricVersion: AUDIT_RUBRIC_VERSION, thresholds: AUDIT_THRESHOLDS, agentNames, updatedAt: new Date().toISOString()
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
  if (meta.status === 'completed' || meta.status === 'cancelled') return { job: publicJob(row), results: await loadResults(sb, jobId), done: true };
  if (meta.pauseRequested) return { job: publicJob(await updateJob(sb, row, { status: 'paused', stage: 'Paused safely — progress is saved', currentConversationId: null })), done: true, paused: true };
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
    const produced = []; const level2AgentIds = await getAuditLevel2Config(sb);
    for (const targetId of targetIds) {
      const agent = admins.find((candidate) => candidate.id === targetId) || { id: targetId, name: turns.find((turn) => turn.authorId === targetId)?.authorName || `Agent ${targetId}` };
      const metrics = deriveMetrics(conversation, turns, targetId, { supportLevel: level2AgentIds.includes(String(targetId)) ? 'level2' : 'standard' });
      row = await updateJob(sb, row, { stage: `Scoring ${agent.name} with evidence`, currentConversationId: item.id });
      const model = await runAuditModel({ transcript: redacted.transcript, evidence: knowledge.evidence, metrics, targetAgent: { token: redacted.agentTokens[targetId] || '[TARGET_AGENT]', conversationAt: conversation.created_at ? new Date(conversation.created_at * 1000).toISOString() : '' } }, sb);
      const restoredAudit = restoreAuditTokens(model.audit, redacted.tokenReplacements);
      const result = await insertResult(sb, access, {
        jobId: String(jobId), status: 'completed', conversationId: String(item.id), conversationDate: conversation.created_at ? new Date(conversation.created_at * 1000).toISOString() : '',
        agentId: targetId, agentName: agent.name, agentEmail: agent.email || '', intercomLink: intercomLink(conversation), audit: restoredAudit, metrics,
        evidence: knowledge.evidence.map(({ kind, id, title, url, postedAt }) => ({ kind, id, title, url, postedAt })), evidenceRetrievedAt: knowledge.retrievedAt,
        redactionCount: redacted.redactionCount, rubricVersion: AUDIT_RUBRIC_VERSION, provider: 'gemini', model: model.model,
        keyName: model.keyName, keyFingerprint: model.keyFingerprint, routeAttempts: model.attempts, usage: model.usage
      });
      produced.push(result);
    }
    const nextProcessed = index + 1;
    const latestControl = (await loadJob(sb, jobId)).metadata || {};
    const controlledStatus = latestControl.cancelRequested ? 'cancelled' : latestControl.pauseRequested ? 'paused' : nextProcessed >= queue.length ? 'completed' : 'running';
    row = await updateJob(sb, row, {
      processed: nextProcessed, completed: Number(meta.completed || 0) + 1, evaluations: Number(meta.evaluations || 0) + produced.length,
      agentNames: [...new Set([...(latestControl.agentNames || meta.agentNames || []), ...produced.map((result) => result.agentName).filter(Boolean)])],
      stage: controlledStatus === 'cancelled' ? 'Audit cancelled — completed results remain saved' : controlledStatus === 'paused' ? 'Paused safely — progress is saved' : nextProcessed >= queue.length ? 'Audit completed' : 'Saved securely — moving to the next conversation',
      status: controlledStatus, currentConversationId: null
    });
    // The replacement map was scoped to this request and becomes unreachable here.
    redacted.ephemeralMap.clear();
    redacted.tokenReplacements.clear();
    return { job: publicJob(row), processed: { conversationId: item.id, status: 'completed', evaluations: produced.length }, results: produced, done: ['paused','cancelled','completed'].includes(controlledStatus) };
  } catch (error) {
    const latestControl = (await loadJob(sb, jobId)).metadata || {};
    if (latestControl.cancelRequested || latestControl.pauseRequested) {
      row = await updateJob(sb, row, {
        status: latestControl.cancelRequested ? 'cancelled' : 'paused',
        stage: latestControl.cancelRequested ? 'Audit cancelled — completed results remain saved' : 'Paused safely — progress is saved',
        currentConversationId: null, error: ''
      });
      return { job: publicJob(row), done: true, cancelled: !!latestControl.cancelRequested, paused: !!latestControl.pauseRequested };
    }
    if (error.code === 'AUDIT_ROUTES_COOLDOWN') {
      row = await updateJob(sb, row, { status: 'running', stage: `Provider cooldown — conversation ${item.id} will retry automatically`, error: error.message, currentConversationId: item.id });
      return { job: publicJob(row), retryAfterMs: Math.min(Number(error.retryAfterMs) || 15000, 30000), retrying: true };
    }
    const attempts = Number(item.attempts || 0) + 1;
    queue[index] = { ...item, attempts };
    if (attempts < 3 && /temporarily unavailable|too long|rate|quota|429|500|502|503|504|fetch/i.test(error.message)) {
      row = await updateJob(sb, row, { queue, status: 'running', stage: `Waiting to retry conversation ${item.id}`, error: error.message, currentConversationId: item.id });
      return { job: publicJob(row), retryAfterMs: 3000, retrying: true };
    }
    const routeAttempts = Array.isArray(error.attempts) ? error.attempts : [];
    const routeSummary = routeAttempts.length ? ` ${routeAttempts.length} provider routes were attempted; details are saved for diagnosis.` : '';
    await insertResult(sb, access, { jobId: String(jobId), status: 'failed', conversationId: String(item.id), error: `${error.message}${routeSummary}`, routeAttempts, rubricVersion: AUDIT_RUBRIC_VERSION }, false);
    const nextProcessed = index + 1;
    row = await updateJob(sb, row, { queue, processed: nextProcessed, failed: Number(meta.failed || 0) + 1, status: nextProcessed >= queue.length ? 'completed' : 'running', stage: nextProcessed >= queue.length ? 'Audit completed with failures' : 'Failure recorded — continuing safely', error: error.message, currentConversationId: null });
    return { job: publicJob(row), processed: { conversationId: item.id, status: 'failed', error: error.message } };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const action = String(req.query.action || req.body?.action || 'bootstrap');
    const access = await authenticateRequest(req) || await authenticateExternalApiKey(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    const sb = supabaseAdmin();
    const permission = access.external ? 'auditor' : await getAuditPermission(access, sb);
    if (!access.external && permission === 'none') return res.status(403).json({ error: 'Conversation Audit access has not been granted to this account.' });
    const identity = await auditIdentity(access, permission, sb);
    if (access.external) {
      const required = action === 'health' || action === 'bootstrap' ? 'diagnostics:read'
        : ['create-job','process-next','pause-job','resume-job','cancel-job'].includes(action) ? 'audit:run'
          : action === 'conversation-view' ? 'transcripts:read-redacted' : 'audit:read';
      if (!hasExternalScope(access, required)) return res.status(403).json({ error: `Developer API key lacks the ${required} permission.` });
    }

    if (req.method === 'GET' && action === 'export') {
      const job = publicJob(await loadJob(sb, req.query.jobId)); let results = await loadResults(sb, req.query.jobId);
      if (permission === 'self') results = results.filter((result) => resultOwnedBy(result, access.email, identity.agentIds));
      if (!results.length && permission === 'self') return res.status(403).json({ error: 'This audit does not contain a result assigned to your email.' });
      const fileBase = auditFileBase(job, results);
      if (req.query.format === 'html') {
        const keys = await getKeys();
        // UI auditors receive the live transcript in the offline report. A
        // developer API key cannot use the report route to bypass its separate
        // transcript permission or redaction boundary.
        const reportResults = access.external ? results : await resultsWithLiveTranscripts(results, keys.intercomToken);
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.html"`);
        return res.status(200).send(auditHtml(job, reportResults));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${fileBase}${req.query.detailed === '1' ? '-detailed' : '-summary'}.csv"`);
      return res.status(200).send(auditCsv(results, req.query.detailed === '1'));
    }

    if (req.method === 'GET' && action === 'job') {
      let job = publicJob(await loadJob(sb, req.query.id)); let results = await loadResults(sb, req.query.id);
      if (permission === 'self') results = results.filter((result) => resultOwnedBy(result, access.email, identity.agentIds));
      if (!results.length && permission === 'self') return res.status(403).json({ error: 'This audit does not contain a result assigned to your email.' });
      if (permission === 'self') job = { ...job, total: results.length, processed: results.length, completed: results.filter((item) => item.status === 'completed').length, evaluations: results.length, skipped: 0, failed: 0, currentConversationId: null, filters: {}, agentNames: [...new Set(results.map((item) => item.agentName).filter(Boolean))] };
      return res.json({ job, results });
    }

    if (req.method === 'GET' && action === 'bootstrap') {
      const keys = await getKeys();
      let admins = []; let intercomError = '';
      if (keys.intercomToken) try { admins = await fetchIntercomAdmins(keys.intercomToken); } catch (error) { intercomError = error.message; }
      const enabledAgentIds = await getAuditAgentConfig(sb, admins);
      const level2AgentIds = await getAuditLevel2Config(sb);
      let jobs = checked(await sb.from('activity_logs').select('*').eq('event_type', 'conversation_audit_job').order('created_at', { ascending: false }).limit(100), 'Could not load audit history');
      const jobIds = (jobs || []).map((row) => String(row.id));
      let recentResults = [];
      if (jobIds.length) {
        const resultQuery = await sb.from('activity_logs').select('id,metadata').eq('event_type', 'conversation_audit_result').in('metadata->>jobId', jobIds).limit(5000);
        if (!resultQuery.error) recentResults = resultQuery.data || [];
      }
      recentResults = recentResults.map((row) => ({ id: row.id, ...(row.metadata || {}) }));
      if (permission === 'self') {
        recentResults = recentResults.filter((result) => resultOwnedBy(result, access.email, identity.agentIds));
        const ownedJobs = new Set(recentResults.map((result) => String(result.jobId)));
        jobs = (jobs || []).filter((job) => ownedJobs.has(String(job.id)));
      }
      const namesByJob = new Map();
      const scoresByJob = new Map();
      for (const row of recentResults) {
        const jobId = String(row.jobId || ''); if (!jobId) continue;
        if (!namesByJob.has(jobId)) namesByJob.set(jobId, new Set());
        if (row.agentName) namesByJob.get(jobId).add(row.agentName);
        if (row.status === 'completed' && row.audit) {
          if (!scoresByJob.has(jobId)) scoresByJob.set(jobId, []);
          scoresByJob.get(jobId).push(row.audit);
        }
      }
      const adminNameById = new Map(admins.map((agent) => [String(agent.id), agent.name]));
      const publicJobs = (jobs || []).map((row) => {
        const id = String(row.id); const filterNames = permission === 'self' ? [] : (row.metadata?.filters?.agentIds || []).map((agentId) => adminNameById.get(String(agentId))).filter(Boolean);
        const scores = scoresByJob.get(id) || []; const average = (key) => scores.length ? Number((scores.reduce((sum, audit) => sum + Number(audit?.[key] || 0), 0) / scores.length).toFixed(2)) : null;
        const quality = average('quality'); const efficiency = average('efficiency'); const process = average('complexity');
        const visible = publicJob(row, { agentNames: [...filterNames, ...(namesByJob.get(id) || [])], scoreSummary: scores.length ? { quality, efficiency, process, final: Number(((quality + efficiency + process) / 3).toFixed(2)) } : null });
        return permission === 'self' ? { ...visible, total: scores.length, processed: scores.length, completed: scores.length, evaluations: scores.length, skipped: 0, failed: 0, currentConversationId: null, filters: {} } : visible;
      });
      return res.json({
        access: { allowed: true, permission, canManage: !access.external && canManageAudits(access), canRun: access.external || ['manager','auditor'].includes(permission), email: access.email || '', config: !access.external && canManageAudits(access) ? await getAuditAccessConfig(sb) : undefined, selfConfig: !access.external && canManageAudits(access) ? await getAuditSelfAccessConfig(sb) : undefined },
        agents: permission === 'self' ? [] : admins, enabledAgentIds: permission === 'self' ? [] : enabledAgentIds, level2AgentIds: permission === 'self' ? [] : level2AgentIds, intercomError, models: permission === 'self' ? [] : await getAuditModels(sb),
        connection: { intercomConfigured: !!keys.intercomToken, geminiKeyCount: (keys.geminiKeyPool || []).length, geminiKeyNames: (keys.geminiKeyPool || []).map((item) => item.name) },
        thresholds: AUDIT_THRESHOLDS, rubricVersion: AUDIT_RUBRIC_VERSION, jobs: publicJobs,
        developerKeys: canManageAudits(access) ? await listExternalApiKeys(sb) : undefined,
        developerScopes: canManageAudits(access) ? EXTERNAL_SCOPES : undefined
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
    const body = req.body || {};
    if (action === 'health') {
      if (permission === 'self') return res.json({ health: { state: 'healthy', checkedAt: new Date().toISOString(), intercom: { connected: true, detail: 'My Audits access ready' }, gemini: [], healthyGeminiKeys: 0 } });
      return res.json({ health: await auditConnections() });
    }
    if (action === 'conversation-view') {
      const conversationId = parseConversationIds(body.conversationId)[0];
      if (!conversationId) throw new Error('A valid conversation ID is required.');
      const keys = await getKeys(); if (!keys.intercomToken) throw new Error('Intercom is not connected.');
      if (permission === 'self') {
        const rows = checked(await sb.from('activity_logs').select('id,metadata').eq('event_type', 'conversation_audit_result').contains('metadata', { conversationId }).limit(100), 'Could not verify transcript access');
        if (!(rows || []).map(publicResult).some((result) => resultOwnedBy(result, access.email, identity.agentIds))) return res.status(403).json({ error: 'You can open transcripts only for your own audit results.' });
      }
      const [conversation, admins] = await Promise.all([fetchConversation(keys.intercomToken, conversationId), fetchIntercomAdmins(keys.intercomToken)]);
      const fullTurns = conversationTurns(conversation, admins);
      if (access.external) {
        const redacted = redactConversation(fullTurns, conversation, admins);
        return res.json({ conversation: { id: conversationId, intercomLink: intercomLink(conversation), redactedTranscript: redacted.transcript, redactionCount: redacted.redactionCount, turns: [] } });
      }
      const turns = fullTurns.map((turn) => ({
        id: turn.id, at: turn.at, kind: turn.kind, authorId: turn.authorId, authorName: turn.authorName,
        body: turn.body, partType: turn.partType, assignedTo: turn.assignedTo, attachments: turn.attachments || []
      }));
      return res.json({ conversation: { id: conversationId, intercomLink: intercomLink(conversation), turns } });
    }
    if (action === 'create-job') { requireRunner(permission, access); return res.json({ job: await createJob(req, access, sb, body) }); }
    if (action === 'process-next') { requireRunner(permission, access); return res.json(await processNext(access, sb, body.jobId)); }
    if (action === 'pause-job') {
      requireRunner(permission, access);
      const row = await loadJob(sb, body.jobId);
      if (['completed','cancelled'].includes(row.metadata?.status)) return res.json({ job: publicJob(row) });
      return res.json({ job: publicJob(await updateJob(sb, row, { pauseRequested: true, status: 'paused', stage: 'Pause requested — finishing the current conversation safely' })) });
    }
    if (action === 'resume-job') {
      requireRunner(permission, access);
      const row = await loadJob(sb, body.jobId);
      if (row.metadata?.status === 'cancelled') throw new Error('A cancelled audit cannot be resumed. Start a new audit instead.');
      return res.json({ job: publicJob(await updateJob(sb, row, { pauseRequested: false, cancelRequested: false, status: 'queued', stage: 'Resume confirmed — preparing the next conversation', error: '' })) });
    }
    if (action === 'cancel-job') {
      requireRunner(permission, access);
      const row = await loadJob(sb, body.jobId);
      if (row.metadata?.status === 'completed') return res.json({ job: publicJob(row) });
      return res.json({ job: publicJob(await updateJob(sb, row, { cancelRequested: true, pauseRequested: false, status: 'cancelled', stage: 'Audit cancelled — completed results remain saved', currentConversationId: null })) });
    }
    if (action === 'delete-jobs') {
      if (access.external || !canManageAudits(access)) return res.status(403).json({ error: 'Master audit access is required to delete audit history.' });
      const jobIds = [...new Set((body.jobIds || []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 100);
      if (!jobIds.length) throw new Error('Select at least one audit batch to delete.');
      const jobRows = checked(await sb.from('activity_logs').select('id,metadata').eq('event_type', 'conversation_audit_job').in('id', jobIds), 'Could not verify audit batches');
      const active = (jobRows || []).filter((row) => ['queued','running','paused'].includes(String(row.metadata?.status || '')));
      if (active.length) throw new Error('Running, queued, or paused audits cannot be deleted. Cancel them first.');
      const resultRows = checked(await sb.from('activity_logs').select('id,metadata').eq('event_type', 'conversation_audit_result').in('metadata->>jobId', jobIds).limit(10000), 'Could not find saved audit results');
      const resultIds = (resultRows || []).map((row) => row.id);
      for (let offset = 0; offset < resultIds.length; offset += 500) {
        const related = resultIds.slice(offset, offset + 500).map(String);
        const removal = await sb.from('activity_logs').delete().in('event_type', ['conversation_audit_dispute','conversation_audit_correction']).in('metadata->>resultId', related);
        if (removal.error) throw new Error(`Could not delete related audit disputes: ${removal.error.message}`);
      }
      for (let offset = 0; offset < resultIds.length; offset += 500) {
        const removal = await sb.from('activity_logs').delete().in('id', resultIds.slice(offset, offset + 500));
        if (removal.error) throw new Error(`Could not delete saved audit results: ${removal.error.message}`);
      }
      const jobRemoval = await sb.from('activity_logs').delete().eq('event_type', 'conversation_audit_job').in('id', jobIds);
      if (jobRemoval.error) throw new Error(`Could not delete audit batches: ${jobRemoval.error.message}`);
      return res.json({ deletedJobs: (jobRows || []).length, deletedResults: resultIds.length, jobIds });
    }
    if (action === 'sync-agents') {
      const keys = await getKeys(); if (!keys.intercomToken) throw new Error('Intercom is not connected.');
      const agents = await fetchIntercomAdmins(keys.intercomToken); const enabledAgentIds = await getAuditAgentConfig(sb, agents); const level2AgentIds = await getAuditLevel2Config(sb);
      return res.json({ agents, enabledAgentIds, level2AgentIds, syncedAt: new Date().toISOString() });
    }
    if (action === 'save-agents') {
      if (!canManageAudits(access)) return res.status(403).json({ error: 'Admin access is required to change the agent dropdown.' });
      const enabledAgentIds = await saveAuditAgentConfig(body.agentIds, sb);
      const level2AgentIds = await saveAuditLevel2Config((body.level2AgentIds || []).filter((id) => enabledAgentIds.includes(String(id))), sb);
      return res.json({ enabledAgentIds, level2AgentIds });
    }
    if (action === 'save-access') {
      if (!canManageAudits(access)) return res.status(403).json({ error: 'Admin access is required to change Audit access.' });
      return res.json({ access: await saveAuditAccessConfig(body.emails, sb) });
    }
    if (action === 'save-self-access') {
      if (!canManageAudits(access)) return res.status(403).json({ error: 'Admin access is required to change My Audits access.' });
      return res.json({ access: await saveAuditSelfAccessConfig(body.emails, sb) });
    }
    if (action === 'submit-dispute') {
      if (access.external) return res.status(403).json({ error: 'Audit disputes require a signed-in workspace account.' });
      const resultId = String(body.resultId || '');
      const reason = String(body.reason || '').trim().slice(0, 4000);
      if (!resultId || reason.length < 10) throw new Error('Explain the audit concern in at least 10 characters.');
      const row = checked(await sb.from('activity_logs').select('id,metadata').eq('id', resultId).eq('event_type', 'conversation_audit_result').maybeSingle(), 'Could not load the audit result');
      if (!row) throw new Error('Audit result not found.');
      const result = publicResult(row);
      if (permission === 'self' && !resultOwnedBy(result, access.email, identity.agentIds)) return res.status(403).json({ error: 'You can dispute only your own audit results.' });
      const existing = checked(await sb.from('activity_logs').select('id,metadata').eq('event_type', 'conversation_audit_dispute').contains('metadata', { resultId }).order('created_at', { ascending: false }).limit(1), 'Could not check existing disputes');
      if (existing?.[0]?.metadata?.status === 'pending') throw new Error('This result already has a pending dispute.');
      const metadata = { resultId, jobId: String(result.jobId || ''), conversationId: String(result.conversationId || ''), agentId: String(result.agentId || ''), agentEmail: result.agentEmail || '', agentName: result.agentName || '', reason, status: 'pending', submittedAt: new Date().toISOString() };
      const created = checked(await sb.from('activity_logs').insert({ actor_role: access.role, session_id: access.sessionId, user_name: access.name, user_email: access.email, auth_provider: access.authProvider, event_type: 'conversation_audit_dispute', success: true, metadata }).select('id,created_at,user_name,user_email,metadata').single(), 'Could not submit the audit dispute');
      return res.json({ dispute: { id: created.id, createdAt: created.created_at, submittedBy: created.user_name || created.user_email || '', submittedByEmail: created.user_email || '', ...created.metadata } });
    }
    if (action === 'review-dispute') {
      if (access.external) return res.status(403).json({ error: 'Audit dispute decisions require a signed-in auditor.' });
      requireRunner(permission, access);
      const disputeId = String(body.disputeId || ''); const decision = String(body.decision || '');
      if (!['approved','rejected'].includes(decision)) throw new Error('Choose approve or reject.');
      const row = checked(await sb.from('activity_logs').select('*').eq('id', disputeId).eq('event_type', 'conversation_audit_dispute').maybeSingle(), 'Could not load the dispute');
      if (!row) throw new Error('Audit dispute not found.');
      const reviewerNote = String(body.reviewerNote || '').trim().slice(0, 4000);
      const correction = String(body.correction || '').trim().slice(0, 6000);
      if (decision === 'approved' && correction.length < 20) throw new Error('Add the corrected audit guidance before approving this dispute.');
      const metadata = { ...(row.metadata || {}), status: decision, reviewerNote, correction, reviewedAt: new Date().toISOString(), reviewedBy: access.name || access.email || '' };
      checked(await sb.from('activity_logs').update({ metadata }).eq('id', disputeId), 'Could not save the dispute decision');
      if (decision === 'approved') {
        await sb.from('activity_logs').insert({ actor_role: access.role, session_id: access.sessionId, user_name: access.name, user_email: access.email, auth_provider: access.authProvider, event_type: 'conversation_audit_correction', success: true, metadata: { disputeId, resultId: metadata.resultId, conversationId: metadata.conversationId, title: `Audit correction · ${metadata.agentName || metadata.conversationId || metadata.resultId}`, instruction: correction, approvedAt: metadata.reviewedAt } });
      }
      return res.json({ dispute: { id: row.id, createdAt: row.created_at, submittedBy: row.user_name || row.user_email || '', submittedByEmail: row.user_email || '', ...metadata } });
    }
    if (action === 'save-models') {
      if (!canManageAudits(access)) return res.status(403).json({ error: 'Admin access is required to change the audit model chain.' });
      return res.json({ models: await saveAuditModels(body.models, sb) });
    }
    if (action === 'external-keys') {
      if (access.external || !canManageAudits(access)) return res.status(403).json({ error: 'Master audit access is required to manage developer API keys.' });
      return res.json({ keys: await listExternalApiKeys(sb), availableScopes: EXTERNAL_SCOPES });
    }
    if (action === 'create-external-key') {
      if (access.external || !canManageAudits(access)) return res.status(403).json({ error: 'Master audit access is required to create developer API keys.' });
      const created = await createExternalApiKey({
        name: body.name, scopes: body.scopes, expiresInDays: body.expiresInDays,
        ownerEmail: access.email, ownerName: access.name
      }, sb);
      return res.json({ ...created, keys: await listExternalApiKeys(sb) });
    }
    if (action === 'revoke-external-key') {
      if (access.external || !canManageAudits(access)) return res.status(403).json({ error: 'Master audit access is required to revoke developer API keys.' });
      await revokeExternalApiKey(body.id, sb);
      return res.json({ ok: true, keys: await listExternalApiKeys(sb) });
    }
    return res.status(400).json({ error: 'Unknown audit action.' });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Audit request failed.' });
  }
}
