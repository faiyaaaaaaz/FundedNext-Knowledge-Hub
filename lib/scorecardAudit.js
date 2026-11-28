// Server glue for scorecard (version 2) audits. Reuses the existing job runner, redaction, evidence
// retrieval, timing ledger and model routing; adds one scorecard call per conversation.
import crypto from 'crypto';
import { getBrandingRules } from './server';
import { fetchTicket, redactConversation, restoreAuditTokens, runAuditModel, parseModelJson } from './audits';
import {
  SCORECARD_VERSION, DEFAULT_SCORECARD_THRESHOLDS, SCORECARD_SYSTEM, buildScorecardPrompt, validateScorecardOutput, assembleScorecard,
  scorecardThresholds, liveChatEfficiency, emailEfficiency, pstfEfficiency, efficiencySection, ticketTurns, liteScorecard, secondsText
} from './scorecards.mjs';

const SCORECARD_REVISION = 'scorecard-2026.11.28-r4';

export function linkedTicketIds(conversation) {
  const ids = [];
  for (const item of conversation?.linked_objects?.data || []) if (String(item?.type || '').toLowerCase() === 'ticket' && item.id) ids.push(String(item.id));
  if (conversation?.ticket?.id) ids.push(String(conversation.ticket.id));
  return [...new Set(ids)];
}

export function isEmailConversation(conversation) {
  const source = conversation?.source || {};
  return String(source.type || '').toLowerCase() === 'email' || String(source.delivered_as || '').toLowerCase() === 'email' || /email/i.test(String(source.type || ''));
}

// Level 1 agents are audited on Live Chat. Level 2 agents on the PSTF ticket when the conversation has one,
// otherwise on Email.
export function chooseTrack({ level2, conversation, ticketIds = [] }) {
  if (!level2) return 'live_chat';
  if (ticketIds.length) return 'pstf';
  return 'email';
}

// Level 2 agents who answered inside the linked ticket (the conversation itself may hold no reply from them).
export async function ticketTargetIds({ token, conversation, admins, level2AgentIds, item }) {
  const ticketIds = linkedTicketIds(conversation);
  if (!ticketIds.length) return { ticketIds, targets: [], tickets: new Map() };
  const tickets = new Map(); const targets = new Set();
  for (const ticketId of ticketIds.slice(0, 3)) {
    try {
      const ticket = await fetchTicket(token, ticketId); tickets.set(ticketId, ticket);
      const turns = ticketTurns(ticket, admins);
      const responders = [...new Set(turns.filter((turn) => turn.kind === 'agent' && !turn.internalNote && turn.partType === 'comment' && String(turn.body || '').trim().length >= 12).map((turn) => String(turn.authorId)))];
      for (const id of responders) if (level2AgentIds.includes(id)) targets.add(id);
    } catch { /* an unreadable ticket simply adds no target */ }
  }
  if (item?.targetAgentId) { const wanted = String(item.targetAgentId); return { ticketIds, tickets, targets: targets.has(wanted) ? [wanted] : [] }; }
  return { ticketIds, tickets, targets: [...targets] };
}

function cacheFingerprint({ track, transcript, evidence, targetAgentId, efficiencyStatus, model }) {
  const stable = (evidence || []).map((entry) => ({ kind: entry.kind, id: entry.id, title: entry.title, postedAt: entry.postedAt || null }));
  return crypto.createHash('sha256').update(JSON.stringify({ rev: SCORECARD_REVISION, model, track, transcript: String(transcript || ''), stable, targetAgentId: String(targetAgentId || ''), efficiencyStatus })).digest('hex');
}

function efficiencySummaryText(section) {
  return section.metrics.map((metric) => `${metric.label}: ${metric.status}${metric.value !== null && metric.value !== undefined ? ` (${secondsText(metric.value)})` : ''}`).join('; ');
}

export async function scoreScorecardTarget({ sb, keys, deadlineAt, conversation, turns, targetId, agent, level2, knowledge, metrics, thresholds, admins, ticketBundle = null, cachedLookup = null }) {
  const limitsAll = scorecardThresholds(thresholds);
  const ticketIds = ticketBundle?.ticketIds || linkedTicketIds(conversation);
  // PSTF only when this agent really answered inside the linked ticket; otherwise a Level 2 agent is scored on Email.
  const answeredInTicket = !!(ticketBundle?.targets || []).map(String).includes(String(targetId));
  const track = chooseTrack({ level2, conversation, ticketIds: answeredInTicket ? ticketIds : [] });
  let activeTurns = turns; let ticketInfo = null; let efficiencyList;
  if (track === 'pstf') {
    const ticketId = ticketIds[0];
    const ticket = ticketBundle?.tickets?.get(ticketId) || await fetchTicket(keys.intercomToken, ticketId);
    const pTurns = ticketTurns(ticket, admins).map((turn) => ({ ...turn, body: turn.ticketState ? `Ticket state changed to ${turn.ticketState.label || 'a new state'}` : turn.body }));
    activeTurns = pTurns;
    // The same redaction as chats, applied to the ticket thread.
    const pstf = pstfEfficiency(ticketTurns(ticket, admins), targetId, limitsAll.pstf);
    efficiencyList = pstf.metrics;
    ticketInfo = { id: ticketId, createdAt: ticket?.created_at || null, state: ticket?.ticket_state?.label || ticket?.state || '' };
  } else if (track === 'email') {
    efficiencyList = emailEfficiency(metrics, limitsAll.email);
  } else {
    efficiencyList = liveChatEfficiency(metrics, limitsAll.live_chat);
  }
  const activeRedacted = redactConversation(activeTurns, conversation, admins, activeTurns, true);
  const activeTranscript = activeRedacted.transcript;
  const section = efficiencySection(track, efficiencyList);
  const evidenceSlim = (knowledge.evidence || []).map(({ kind, id, title, url, postedAt }) => ({ kind, id, title, url, postedAt }));
  // Scorecard verdicts are judgments, so they use a stronger first-choice model than the cheap default chain.
  const preferred = String((await sb.from('settings').select('value').eq('key', 'scorecard_audit_model').maybeSingle()).data?.value || 'gemini-3.5-flash').trim();
  const fingerprint = cacheFingerprint({ model: preferred, track, transcript: activeTranscript, evidence: knowledge.evidence, targetAgentId: targetId, efficiencyStatus: efficiencyList.map((metric) => `${metric.key}:${metric.status}:${metric.value}`) });
  const cached = cachedLookup ? await cachedLookup(fingerprint) : null;
  if (cached?.scorecard) return { cached, fingerprint, track };

  const brandRules = await getBrandingRules().catch(() => []);
  const token = activeRedacted.agentTokens[targetId] || '[TARGET_AGENT]';
  const model = await runAuditModel({
    transcript: activeTranscript, evidence: knowledge.evidence, metrics,
    targetAgent: { token, conversationAt: conversation.created_at ? new Date(conversation.created_at * 1000).toISOString() : '' }
  }, sb, {
    deadlineAt, keys,
    custom: {
      system: SCORECARD_SYSTEM,
      models: [...new Set([preferred, 'gemini-3.5-flash', 'gemini-3.8-flash'].filter(Boolean))],
      buildPrompt: ({ compact, targetToken, evidenceText }) => buildScorecardPrompt({ track, targetToken, conversationAt: conversation.created_at ? new Date(conversation.created_at * 1000).toISOString() : '', evidenceText, transcriptText: compact.text, efficiencySummary: efficiencySummaryText(section), brandRules }),
      validate: (parsed, { compact, evidence }) => validateScorecardOutput(parsed, { track, refs: compact.refs, evidence })
    }
  });
  const scorecard = restoreAuditTokens(assembleScorecard({ track, validated: model.audit, efficiency: section, ticket: ticketInfo }), activeRedacted.tokenReplacements);
  const lite = liteScorecard(scorecard);
  const failedClusters = scorecard.clusters.filter((cluster) => cluster.failed).map((cluster) => cluster.name);
  const criticalNames = scorecard.critical.items.filter((item) => item.failed).map((item) => item.name);
  const headline = scorecard.summary.headline || (criticalNames.length ? `Critical failure: ${criticalNames.join(', ')}.` : failedClusters.length ? `Scorecard findings in ${failedClusters.join(', ')}.` : 'No scorecard findings.');
  const audit = {
    scorecard: true, track, finalScore: Math.round(scorecard.total * 1000) / 100, resolutionStatus: scorecard.outcome === 'pass' ? 'Pass' : scorecard.outcome === 'critical_fail' ? 'Critical failure' : 'Below pass mark',
    primaryIssue: criticalNames[0] || failedClusters[0] || 'No findings', mainFinding: headline, issue: headline, manualReview: scorecard.manualReview, manualReviewReasons: scorecard.manualReviewReasons,
    confidence: scorecard.confidence, strengths: scorecard.summary.strengths, coachingActions: scorecard.summary.coaching, deductions: []
  };
  return { track, fingerprint, scorecard, scorecardLite: lite, audit, evidence: evidenceSlim, model, ticketInfo, tokens: activeRedacted };
}

// Fields stored on the result row (the caller adds job, conversation and agent identity).
export function scorecardResultFields(outcome) {
  return {
    scorecardVersion: SCORECARD_VERSION, scorecardRevision: SCORECARD_REVISION, track: outcome.track,
    scorecard: outcome.scorecard, scorecardLite: outcome.scorecardLite, audit: outcome.audit,
    ...(outcome.ticketInfo ? { ticket: outcome.ticketInfo } : {}),
    auditInputFingerprint: outcome.fingerprint
  };
}
