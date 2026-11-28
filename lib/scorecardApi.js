// Data endpoints for the Metric Scores and Agent Scores screens. Pure reads over saved results.
import { fetchIntercomAdmins, getAuditAgentConfig, getAuditLevel2Config } from './audits';
import { getKeys } from './server';
import { TRACKS, aggregateScorecards, aggregateLegacy, applyScorecardEdit, liteScorecard } from './scorecards.mjs';

const LEVEL_TRACKS = { L1: ['live_chat'], L2: ['email', 'pstf'] };
const MAX_ROWS = 4000;

function checked(result, label) { if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data; }

function range(body) {
  const to = /^\d{4}-\d\d-\d\d$/.test(String(body.to || '')) ? String(body.to) : new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10);
  const from = /^\d{4}-\d\d-\d\d$/.test(String(body.from || '')) ? String(body.from) : new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}
const dayIso = (day, end = false) => new Date(`${day}${end ? 'T23:59:59' : 'T00:00:00'}+06:00`).toISOString();

async function loadRows(sb, { source, from, to }) {
  // Lite columns only: the aggregates never need quotes or summaries.
  const select = 'id,created_at,jobId:metadata->>jobId,conversationId:metadata->>conversationId,conversationDate:metadata->>conversationDate,agentId:metadata->>agentId,agentName:metadata->>agentName,agentEmail:metadata->>agentEmail,status:metadata->>status,track:metadata->>track,scorecard:metadata->scorecardLite';
  let query = sb.from('activity_logs').select(source === 'legacy' ? select.replace('scorecard:metadata->scorecardLite', 'audit:metadata->audit,scorecardMarker:metadata->scorecardLite') : select)
    .eq('event_type', 'conversation_audit_result').eq('success', true).gte('metadata->>conversationDate', dayIso(from)).lte('metadata->>conversationDate', dayIso(to, true))
    .order('created_at', { ascending: false }).limit(MAX_ROWS);
  if (source === 'legacy') query = query.is('metadata->scorecardLite', null);
  else query = query.not('metadata->scorecardLite', 'is', null);
  const rows = checked(await query, 'Could not load audit results');
  return (rows || []).map((row) => ({ ...row, scorecard: source === 'legacy' ? null : row.scorecard }));
}

// A manager sees every agent; a self-access user only their own rows.
function visible(rows, permission, access, identity) {
  if (permission !== 'self') return rows;
  const email = String(access.email || '').trim().toLowerCase();
  return rows.filter((row) => (email && String(row.agentEmail || '').trim().toLowerCase() === email) || (identity.agentIds || []).includes(String(row.agentId || '')));
}

async function rosterFor(level, sb) {
  const keys = await getKeys();
  const admins = keys.intercomToken ? await fetchIntercomAdmins(keys.intercomToken).catch(() => []) : [];
  const enabled = (await getAuditAgentConfig(sb, admins)).map(String);
  const level2 = (await getAuditLevel2Config(sb)).map(String);
  const ids = level === 'L2' ? level2.filter((id) => enabled.includes(id) || true) : enabled.filter((id) => !level2.includes(id));
  return ids.map((id) => ({ agentId: id, agentName: admins.find((admin) => String(admin.id) === id)?.name || `Agent ${id}`, agentEmail: admins.find((admin) => String(admin.id) === id)?.email || '' }));
}

function previousRange({ from, to }) {
  const length = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  const prevTo = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const prevFrom = new Date(Date.parse(`${prevTo}T00:00:00Z`) - (length - 1) * 86400000).toISOString().slice(0, 10);
  return { from: prevFrom, to: prevTo };
}

const trackLabel = (track) => TRACKS[track]?.label || track;
const level = (body) => (String(body.level).toUpperCase() === 'L2' ? 'L2' : 'L1');
const sourceOf = (body) => (body.source === 'legacy' ? 'legacy' : 'scorecard');

export async function handleScoreAction({ action, body, sb, access, permission, identity, recordView, canReview = false }) {
  if (!['search-results', 'score-overview', 'score-agents', 'score-conversations', 'score-result', 'edit-scorecard'].includes(action)) return null;
  const source = sourceOf(body);

  if (action === 'search-results') {
    const id = String(body.conversationId || '').trim();
    if (!/^\d{1,40}$/.test(id)) return { items: [] };
    const rows = checked(await sb.from('activity_logs')
      .select('id,created_at,agentId:metadata->>agentId,agentEmail:metadata->>agentEmail,agentName:metadata->>agentName')
      .eq('event_type', 'conversation_audit_result').eq('success', true)
      .eq('metadata->>conversationId', id).order('created_at', { ascending: false }), 'Could not search results');
    return { items: visible(rows || [], permission, access, identity).map(({ id, created_at, agentName }) => ({ id, createdAt: created_at, agentName })) };
  }

  if (action === 'score-result') {
    const row = checked(await sb.from('activity_logs').select('id,created_at,metadata').eq('id', String(body.resultId || '')).eq('event_type', 'conversation_audit_result').maybeSingle(), 'Could not load the result');
    if (!row) { const error = new Error('Result not found.'); error.status = 404; throw error; }
    const result = { id: row.id, createdAt: row.created_at, ...(row.metadata || {}) };
    if (permission === 'self') { const owned = visible([{ ...result }], permission, access, identity); if (!owned.length) { const error = new Error('You can open only your own audit results.'); error.status = 403; throw error; } }
    return { result };
  }

  if (action === 'edit-scorecard') {
    if (!canReview) { const error = new Error('Only audit reviewers can change a scorecard verdict.'); error.status = 403; throw error; }
    const reason = String(body.reason || '').trim();
    if (reason.length < 10) throw new Error('Explain the change in at least 10 characters.');
    const row = checked(await sb.from('activity_logs').select('id,created_at,metadata').eq('id', String(body.resultId || '')).eq('event_type', 'conversation_audit_result').maybeSingle(), 'Could not load the result');
    if (!row?.metadata?.scorecard) throw new Error('This result has no scorecard to edit.');
    const next = applyScorecardEdit(row.metadata.scorecard, { key: String(body.key || ''), failed: body.failed === true, reason, by: access.name || access.email || 'Reviewer' });
    const audit = { ...(row.metadata.audit || {}), finalScore: Math.round(next.total * 1000) / 100, resolutionStatus: next.outcome === 'pass' ? 'Pass' : next.outcome === 'critical_fail' ? 'Critical failure' : 'Below pass mark' };
    const metadata = { ...row.metadata, scorecard: next, scorecardLite: liteScorecard(next), audit };
    checked(await sb.from('activity_logs').update({ metadata }).eq('id', row.id).select('id').single(), 'Could not save the change');
    await recordView('audit_score_edited', { resultId: String(row.id), key: String(body.key), to: body.failed === true ? 'failed' : 'met' });
    return { result: { id: row.id, createdAt: row.created_at, ...metadata } };
  }
  const lvl = level(body); const { from, to } = range(body);
  if (!access.external) await recordView('audit_scores_viewed', { action, level: lvl, source, agentId: String(body.agentId || ''), from, to });

  if (action === 'score-overview') {
    const rows = visible(await loadRows(sb, { source, from, to }), permission, access, identity);
    if (source === 'legacy') {
      const prevRows = visible(await loadRows(sb, { source, ...previousRange({ from, to }) }), permission, access, identity);
      return { level: lvl, source, range: { from, to }, tracks: [{ track: 'legacy', trackLabel: 'Old Metrics Evaluations', overview: aggregateLegacy(rows), previous: aggregateLegacy(prevRows) }] };
    }
    const prev = visible(await loadRows(sb, { source, ...previousRange({ from, to }) }), permission, access, identity);
    const tracks = LEVEL_TRACKS[lvl].map((track) => ({ track, trackLabel: trackLabel(track), definition: { critical: TRACKS[track].critical.map((item) => ({ key: item.key, name: item.name })), clusters: TRACKS[track].clusters.map((cluster) => ({ key: cluster.key, name: cluster.name, max: cluster.max })) }, overview: aggregateScorecards(rows, { track }), previous: aggregateScorecards(prev, { track }) }));
    return { level: lvl, source, range: { from, to }, tracks };
  }

  if (action === 'score-agents') {
    const rows = visible(await loadRows(sb, { source, from, to }), permission, access, identity);
    const roster = permission === 'self' ? [] : await rosterFor(lvl, sb);
    const groups = source === 'legacy' ? [{ track: 'legacy', trackLabel: 'Old Metrics Evaluations', agents: aggregateLegacy(rows, { groupBy: 'agent' }) }]
      : LEVEL_TRACKS[lvl].map((track) => ({ track, trackLabel: trackLabel(track), agents: aggregateScorecards(rows, { track, groupBy: 'agent' }) }));
    // Everyone available for the level appears, including agents with no evaluation in the period.
    const seen = new Set(groups.flatMap((group) => group.agents.map((agent) => agent.agentId)));
    const empty = roster.filter((agent) => !seen.has(agent.agentId)).map((agent) => ({ agentId: agent.agentId, agentName: agent.agentName, evaluated: 0 }));
    return { level: lvl, source, range: { from, to }, tracks: groups, noEvaluations: empty };
  }

  // score-conversations: every conversation behind one agent's metric score.
  const track = String(body.track || '');
  const metric = String(body.metric || 'total');
  const rows = visible(await loadRows(sb, { source, from, to }), permission, access, identity).filter((row) => String(row.agentId) === String(body.agentId || '') && row.status === 'completed' && (source === 'legacy' || row.scorecard?.track === track));
  const items = rows.map((row) => {
    const sc = row.scorecard;
    if (!sc) { const audit = row.audit || {}; return { resultId: row.id, jobId: row.jobId, conversationId: row.conversationId, conversationDate: row.conversationDate, agentId: row.agentId, agentName: row.agentName, track: 'legacy', total: Number(audit.finalScore) * 10, outcome: 'legacy', metricScore: metric === 'total' ? Number(audit.finalScore) : Number(audit[metric === 'process' ? 'complexity' : metric]), metricMax: 10, metricFailed: null, markedRootCauses: [], efficiency: [] }; }
    const cluster = sc.clusters.find((item) => item.key === metric);
    const criticalItem = sc.critical.items.find((item) => item.key === metric);
    const effMetric = metric.startsWith('efficiency:') ? (sc.efficiency?.metrics || []).find((item) => item.key === metric.split(':')[1]) : null;
    return { resultId: row.id, jobId: row.jobId, conversationId: row.conversationId, conversationDate: row.conversationDate, agentId: row.agentId, agentName: row.agentName, track: sc.track, trackLabel: sc.trackLabel,
      total: Math.round(sc.total * 1000) / 10, outcome: sc.outcome, criticalFailed: sc.critical.failed,
      metricScore: cluster ? cluster.earned : effMetric ? effMetric.value : null, metricMax: cluster ? cluster.max : null,
      metricFailed: cluster ? cluster.failed : criticalItem ? criticalItem.failed : effMetric ? effMetric.status === 'breach' : sc.outcome !== 'pass',
      metricStatus: effMetric ? effMetric.status : null,
      markedRootCauses: (cluster?.rootCauses || []).filter((cause) => cause.marked).map((cause) => cause.label),
      efficiency: (sc.efficiency?.metrics || []).map((item) => ({ key: item.key, label: item.label, status: item.status, value: item.value, target: item.target })), manualReview: sc.manualReview };
  });
  const failedOnly = body.failedOnly === true;
  const list = items.filter((item) => !failedOnly || item.metricFailed).sort((a, b) => String(b.conversationDate).localeCompare(String(a.conversationDate)));
  return { level: lvl, source, range: { from, to }, track, metric, agentId: String(body.agentId || ''), agentName: rows[0]?.agentName || '', count: list.length, totalForAgent: items.length, items: list };
}
