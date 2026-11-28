import assert from 'node:assert/strict';
import { TRACKS, maxPoints, validateScorecardOutput, assembleScorecard, efficiencySection, liveChatEfficiency, emailEfficiency, pstfEfficiency, ticketTurns, quoteIn, aggregateScorecards, buildScorecardPrompt, applyScorecardEdit, scorecardThresholds, DEFAULT_SCORECARD_THRESHOLDS } from '../lib/scorecards.mjs';

// Each track totals exactly 100 scored points.
for (const key of Object.keys(TRACKS)) assert.equal(maxPoints(key), 100, key);
assert.deepEqual(TRACKS.live_chat.clusters.map((c) => c.max), [15, 25, 15, 25, 10, 5, 5]);
assert.deepEqual(TRACKS.email.clusters.map((c) => c.max), [20, 25, 30, 10, 10, 5]);
assert.deepEqual(TRACKS.pstf.clusters.map((c) => c.max), [30, 25, 25, 10, 10]);

const refs = new Map([[1, { at: 1000, speaker: 'client', text: 'My payout is late and I am upset.' }], [2, { at: 1030, speaker: 'agent', text: 'Hello, please wait while I check your account details.' }], [3, { at: 1100, speaker: 'agent', text: 'The payout takes 30 days to process, thank you.' }]]);
const evidence = [{ kind: 'FAQ', title: 'How long does a payout take?', url: 'https://help.fundednext.com/en/articles/1-x', text: 'Payouts take 24 hours.' }];
const eff = (breach) => efficiencySection('live_chat', [{ key: 'frt', status: breach ? 'breach' : 'hit' }]);
const find = (cluster, rootCause, extra = {}) => ({ cluster, rootCause, refs: [2], quotes: ['please wait while I check your account details'], what: 'x', why: 'y', recommendation: 'z', ...extra });
const score = (track, findings, breach = false) => assembleScorecard({ track, validated: validateScorecardOutput({ findings }, { track, refs, evidence }), efficiency: track === 'live_chat' ? eff(breach) : efficiencySection(track, [{ key: 'aht', status: 'hit' }]) });

// Worked examples from the QC workbook (Live Chat): points lost -> final score and outcome.
let s = score('live_chat', []); assert.equal(s.totalPoints, 100); assert.equal(s.outcome, 'pass');
s = score('live_chat', [find('etiquette', 'lack_of_empathy')]); assert.equal(s.totalPoints, 85); assert.equal(s.outcome, 'fail');
s = score('live_chat', [], true); assert.equal(s.totalPoints, 75); assert.equal(s.outcome, 'fail');
s = score('live_chat', [find('generic', 'unpersonalized_template')]); assert.equal(s.totalPoints, 85);
s = score('live_chat', [find('fcr', 'incomplete_resolution'), find('fcr', 'unnecessary_holding')]); assert.equal(s.totalPoints, 75, 'one FCR cluster failure loses 25 once');
s = score('live_chat', [find('review', 'missing_review', { absence: true })]); assert.equal(s.totalPoints, 90); assert.equal(s.outcome, 'pass', 'a single 10 point loss passes at exactly 90%');
s = score('live_chat', [find('opening', 'transfer_failure', { absence: true })]); assert.equal(s.totalPoints, 95); assert.equal(s.outcome, 'pass');
s = score('live_chat', [find('opening', 'improper_greeting', { absence: true }), find('opening', 'transfer_failure', { absence: true })]); assert.equal(s.totalPoints, 95, 'opening cluster loses 5 once');
s = score('live_chat', [find('review', 'missing_review', { absence: true }), find('branding', 'grammatical_error')]); assert.equal(s.totalPoints, 85); assert.equal(s.outcome, 'fail');
s = score('live_chat', [find('opening', 'transfer_failure', { absence: true }), find('branding', 'grammatical_error')]); assert.equal(s.totalPoints, 90); assert.equal(s.outcome, 'pass');
s = score('live_chat', [find('etiquette', 'lack_of_empathy'), find('fcr', 'incomplete_resolution')]); assert.equal(s.totalPoints, 60);
// Everything failed -> 0.
s = score('live_chat', ['etiquette:lack_of_empathy', 'generic:unpersonalized_template', 'fcr:incomplete_resolution', 'review:missing_review', 'opening:transfer_failure', 'branding:grammatical_error'].map((k) => find(...k.split(':'), { absence: true })), true); assert.equal(s.totalPoints, 0);
// Critical failure overrides to 0%, even with a perfect rest.
s = score('live_chat', [find('unprofessional_conduct', 'prohibited_conduct', { quotes: ['The payout takes 30 days to process'], refs: [3] })]); assert.equal(s.outcome, 'critical_fail'); assert.equal(s.totalPoints, 0); assert.equal(s.total, 0); assert.equal(s.passed, false);
// Email examples.
s = score('email', [find('etiquette', 'lack_of_empathy')]); assert.equal(s.totalPoints, 80); assert.equal(s.outcome, 'fail');
s = score('email', [find('fcr', 'unnecessary_information_asked')]); assert.equal(s.totalPoints, 70);
s = score('email', [find('format_handoff', 'incorrect_email_format', { absence: true }), find('format_handoff', 'missing_transfer_summary', { absence: true })]); assert.equal(s.totalPoints, 90); assert.equal(s.outcome, 'pass');
// PSTF examples (weights 30/25/25/10/10).
s = score('pstf', [find('documentation', 'documentation_failure', { absence: true })]); assert.equal(s.totalPoints, 70);
s = score('pstf', [find('review', 'incorrect_review')]); assert.equal(s.totalPoints, 90); assert.equal(s.outcome, 'pass');

// Verification: wrong quote, wrong speaker, missing source, manual-only criterion.
let v = validateScorecardOutput({ findings: [find('etiquette', 'lack_of_empathy', { quotes: ['words the agent never wrote at all'] })] }, { track: 'live_chat', refs, evidence });
assert.equal(v.findings.length, 0); assert.equal(v.rejected.length, 1);
v = validateScorecardOutput({ findings: [find('etiquette', 'lack_of_empathy', { refs: [1], quotes: ['My payout is late and I am upset'] })] }, { track: 'live_chat', refs, evidence });
assert.equal(v.findings.length, 0, 'a client quote can never support an agent finding');
v = validateScorecardOutput({ findings: [find('incorrect_information', 'incorrect_information', { refs: [3], quotes: ['The payout takes 30 days to process'] })] }, { track: 'live_chat', refs, evidence });
assert.equal(v.findings.length, 0, 'incorrect information without a cited article is not scored');
v = validateScorecardOutput({ findings: [find('incorrect_information', 'incorrect_information', { refs: [3], quotes: ['The payout takes 30 days to process'], sourceIds: [1] })] }, { track: 'live_chat', refs, evidence });
assert.equal(v.findings.length, 1); assert.equal(v.findings[0].sources[0].url, evidence[0].url); assert.equal(v.findings[0].sources[0].title, 'How long does a payout take?');
v = validateScorecardOutput({ findings: [find('escalation', 'escalation_failure')] }, { track: 'live_chat', refs, evidence });
assert.equal(v.findings.length, 0); assert.equal(v.manual.length, 1);
v = validateScorecardOutput({ findings: [find('efficiency', 'x')] }, { track: 'live_chat', refs, evidence }); assert.equal(v.findings.length, 0, 'the model can never mark Efficiency Metrics');
assert.ok(quoteIn('Please wait, while I check your account details!', refs.get(2).text));
assert.ok(!quoteIn('completely different sentence about payouts and refunds', refs.get(2).text));

// Live chat efficiency: FRT, ART and the 12 minute / 6 minute AHT windows.
const limits = DEFAULT_SCORECARD_THRESHOLDS.live_chat;
let m = liveChatEfficiency({ frtSeconds: 20, responseTimes: [40, 60], artBreaches: 0, responseCycles: [], ahtSeconds: 400, ahtCycles: [{ responseSeconds: 300, wrapUpSeconds: 100 }] }, limits);
assert.deepEqual(m.map((x) => x.status), ['hit', 'hit', 'hit']);
m = liveChatEfficiency({ frtSeconds: 45, responseTimes: [100], artBreaches: 1, responseCycles: [{ replyId: 'r1', breached: true, replyAt: 5 }], ahtSeconds: 900, ahtCycles: [{ responseSeconds: 800, wrapUpSeconds: 100 }] }, limits);
assert.deepEqual(m.map((x) => x.status), ['breach', 'breach', 'breach']); assert.equal(m[1].anchors[0].id, 'metric-art-r1');
m = liveChatEfficiency({ frtSeconds: 20, responseTimes: [40], artBreaches: 0, responseCycles: [], ahtSeconds: 600, ahtCycles: [{ responseSeconds: 300, wrapUpSeconds: 400 }], lateSnoozes: [{ delaySeconds: 400, at: 7 }] }, limits); assert.equal(m[2].status, 'breach', 'an agent snooze more than 6 minutes after the reply');
m = liveChatEfficiency({ frtSeconds: 20, responseTimes: [40], artBreaches: 0, responseCycles: [], ahtSeconds: 600, ahtCycles: [{ responseSeconds: 300, wrapUpSeconds: 362 }] }, limits); assert.equal(m[2].status, 'hit', 'a system timer snooze at 6m 2s is not the agent\'s breach');
m = liveChatEfficiency({ frtSeconds: 20, responseTimes: [40], artBreaches: 0, responseCycles: [], ahtSeconds: 300, ahtCycles: [{ responseSeconds: 300, wrapUpSeconds: 60 }], lateSnoozes: [{ delaySeconds: 250, at: 9 }] }, limits); assert.equal(m[2].status, 'hit', 'a 4 minute snooze is inside the 6 minute window');
m = liveChatEfficiency({ frtSeconds: 20, responseTimes: [40], artBreaches: 0, responseCycles: [], ahtSeconds: 300, ahtCycles: [{ responseSeconds: 300, wrapUpSeconds: 60 }], lateSnoozes: [{ delaySeconds: 500, at: 9 }] }, limits); assert.equal(m[2].status, 'breach'); assert.ok(m[2].reasons[0].includes('Snoozed'));
m = liveChatEfficiency({ frtSeconds: null, responseTimes: [], responseCycles: [], ahtSeconds: null, ahtCycles: [{ incomplete: true }], timingUnavailableReasons: ['No assignment event'] }, limits);
assert.deepEqual(m.map((x) => x.status), ['unavailable', 'unavailable', 'unavailable']);
assert.equal(efficiencySection('live_chat', m).status, 'unavailable', 'unmeasurable timing is excluded, not scored as a breach');
assert.equal(emailEfficiency({ ahtSeconds: 200 }, { ahtSeconds: 300 })[0].status, 'hit'); assert.equal(emailEfficiency({ ahtSeconds: 500 }, { ahtSeconds: 300 })[0].status, 'breach');
assert.equal(scorecardThresholds({ level2: { ahtSeconds: 240 } }).email.ahtSeconds, 240);

// PSTF: SLA runs from the LAST assignment to this agent.
const ticket = { id: 'T1', created_at: 1000, ticket_parts: { ticket_parts: [
  { id: 'a1', part_type: 'assignment', created_at: 1100, author: { type: 'admin', id: '1' }, assigned_to: { id: '77' } },
  { id: 'a2', part_type: 'assignment', created_at: 5000, author: { type: 'admin', id: '1' }, assigned_to: { id: '42' } },
  { id: 'a3', part_type: 'assignment', created_at: 6000, author: { type: 'admin', id: '1' }, assigned_to: { id: '77' } },
  { id: 'c1', part_type: 'comment', created_at: 6600, author: { type: 'admin', id: '77', name: 'Agent' }, body: '<p>Hello, here is your verdict.</p>' },
  { id: 'n1', part_type: 'note', created_at: 6700, author: { type: 'admin', id: '77' }, body: 'internal' },
  { id: 's1', part_type: 'ticket_state_updated', created_at: 6900, author: { type: 'admin', id: '77' }, ticket_state: { label: 'Resolved', category: 'resolved' } }
] } };
const turns = ticketTurns(ticket, []);
assert.equal(turns.length, 6); assert.equal(turns.find((x) => x.id === 'n1').internalNote, true);
let p = pstfEfficiency(turns, '77', { slaSeconds: 3600 }, 99999);
assert.equal(p.metrics[0].assignedAt, 6000, 'the LAST assignment is the SLA anchor, not the first'); assert.equal(p.metrics[0].value, 600); assert.equal(p.metrics[0].status, 'hit'); assert.equal(p.metrics[1].status, 'hit');
const late = ticketTurns({ ...ticket, ticket_parts: { ticket_parts: ticket.ticket_parts.ticket_parts.map((x) => x.id === 'c1' ? { ...x, created_at: 6000 + 3700 } : x.id === 's1' ? { ...x, created_at: 11000 } : x.id === 'n1' ? { ...x, created_at: 9800 } : x) } }, []);
p = pstfEfficiency(late, '77'); assert.equal(p.metrics[0].status, 'breach'); assert.equal(p.metrics[0].value, 3700);
p = pstfEfficiency(ticketTurns({ id: 'T2', created_at: 1, ticket_parts: { ticket_parts: [{ id: 'a', part_type: 'assignment', created_at: 100, assigned_to: { id: '77' }, author: { type: 'admin', id: '1' } }] } }, []), '77'); assert.equal(p.metrics[0].status, 'breach'); assert.ok(/No customer-facing reply/.test(p.metrics[0].detail));
p = pstfEfficiency(ticketTurns({ id: 'T3', created_at: 1, ticket_parts: { ticket_parts: [{ id: 'a', part_type: 'assignment', created_at: 100, assigned_to: { id: '77' }, author: { type: 'admin', id: '1' } }, { id: 'b', part_type: 'assignment', created_at: 900, assigned_to: { id: '5' }, author: { type: 'admin', id: '1' } }] } }, []), '77'); assert.equal(p.metrics[0].status, 'unavailable', 'reassigned before the SLA window ended');
p = pstfEfficiency(turns, '999'); assert.equal(p.metrics[0].status, 'unavailable');

// Prompt contains every root cause key, the deterministic cluster note and stays compact.
for (const key of Object.keys(TRACKS)) { const prompt = buildScorecardPrompt({ track: key, targetToken: '[AGENT_001]', transcriptText: '#1 CLIENT: hi' }); for (const c of TRACKS[key].clusters) for (const r of c.rootCauses) assert.ok(prompt.includes(r.key), `${key} ${r.key}`); assert.ok(prompt.length < 11000, `${key} prompt is ${prompt.length} chars`); }

// Aggregation.
const row = (id, agent, total, passed, week) => ({ id, status: 'completed', conversationId: String(id), agentId: agent, agentName: `A${agent}`, conversationDate: week, scorecard: { track: 'live_chat', total, passed, critical: { failed: false, items: TRACKS.live_chat.critical.map((c) => ({ key: c.key, failed: false })) }, manualReview: false, clusters: TRACKS.live_chat.clusters.map((c) => ({ key: c.key, name: c.name, max: c.max, earned: c.key === 'etiquette' && !passed ? 0 : c.max, failed: c.key === 'etiquette' && !passed, rootCauses: c.rootCauses.map((r) => ({ key: r.key, marked: c.key === 'etiquette' && !passed && r.key === 'lack_of_empathy' })) })), efficiency: { metrics: [{ key: 'frt', label: 'FRT', status: passed ? 'hit' : 'breach', value: passed ? 20 : 50, target: 30 }] } } });
const rows = [row(1, '1', 1, true, '2026-11-02T05:00:00Z'), row(2, '1', 0.85, false, '2026-11-03T05:00:00Z'), row(3, '2', 1, true, '2026-11-10T05:00:00Z')];
const agg = aggregateScorecards(rows, { track: 'live_chat' });
assert.equal(agg.evaluated, 3); assert.equal(agg.passRate, 66.7); assert.equal(agg.clusters[0].failed, 1); assert.equal(agg.clusters[0].rootCauses.find((r) => r.key === 'lack_of_empathy').count, 1); assert.equal(agg.trend.length, 2); assert.equal(agg.efficiency[0].breaches, 1);
const byAgent = aggregateScorecards(rows, { track: 'live_chat', groupBy: 'agent' }); assert.equal(byAgent.length, 2); assert.equal(byAgent[0].agentId, '1', 'weakest agent first');
assert.equal(aggregateScorecards(rows, { track: 'email' }).evaluated, 0);
console.log('scorecards: all scenarios passed');

// Auditor edits recalculate with the same rules and keep the original verdict on record.
{
  let base = score('live_chat', [find('etiquette', 'lack_of_empathy')]);
  assert.equal(base.totalPoints, 85);
  let edited = applyScorecardEdit(base, { key: 'etiquette', failed: false, reason: 'The apology was in the first reply.', by: 'QA' });
  assert.equal(edited.totalPoints, 100); assert.equal(edited.outcome, 'pass'); assert.equal(edited.edits[0].from, 'failed'); assert.equal(base.totalPoints, 85, 'the original object is untouched');
  edited = applyScorecardEdit(edited, { key: 'unprofessional_conduct', failed: true, reason: 'Sarcastic remark confirmed.' }); assert.equal(edited.outcome, 'critical_fail'); assert.equal(edited.totalPoints, 0);
  edited = applyScorecardEdit(edited, { key: 'unprofessional_conduct', failed: false, reason: 'Overturned on review.' }); assert.equal(edited.outcome, 'pass'); assert.equal(edited.edits.length, 3);
  assert.throws(() => applyScorecardEdit(base, { key: 'etiquette', failed: true, reason: 'x' }), /already marked/);
  assert.throws(() => applyScorecardEdit(base, { key: 'nope', failed: true, reason: 'x' }), /Unknown/);
  const e2 = applyScorecardEdit(score('live_chat', [], false), { key: 'efficiency', failed: true, reason: 'Late snooze confirmed manually.' }); assert.equal(e2.totalPoints, 75); assert.equal(e2.efficiency.status, 'breach');
}
console.log('scorecards: edits passed');
// The verifier attaches a verbatim quote to the right TARGET message even when the model numbered the wrong one,
// accepts display names for criteria, and still refuses invented quotes and client words.
{
  const r2 = new Map([[1, { at: 10, speaker: 'client', text: 'Thanks, can you help with my withdrawal?' }], [2, { at: 20, speaker: 'agent', text: 'Hello! Please leave us a review on Trustpilot if you are satisfied.' }], [3, { at: 30, speaker: 'agent', text: 'Let me check your account.' }]]);
  let v = validateScorecardOutput({ findings: [{ cluster: 'review', rootCause: 'incorrect_review', refs: [3], quotes: ['leave us a review on Trustpilot'], what: 'Review asked before any help', why: 'w', recommendation: 'r' }] }, { track: 'live_chat', refs: r2, evidence: [] });
  assert.equal(v.findings.length, 1); assert.equal(v.findings[0].evidence.find((e) => e.verified).ref, 2); assert.equal(v.findings[0].evidence.find((e) => e.verified).relocated, true);
  v = validateScorecardOutput({ findings: [{ cluster: 'Review Approach', rootCause: 'Incorrect Review Approach', refs: [2], quotes: ['leave us a review on Trustpilot'], what: 'x', why: 'y', recommendation: 'z' }] }, { track: 'live_chat', refs: r2, evidence: [] });
  assert.equal(v.findings.length, 1, 'display names are accepted'); assert.equal(v.findings[0].cluster, 'review');
  v = validateScorecardOutput({ findings: [{ cluster: '', rootCause: 'incorrect_review', refs: [2], quotes: ['please leave us a review on Trustpilot'], what: 'x', why: 'y', recommendation: 'z' }] }, { track: 'live_chat', refs: r2, evidence: [] });
  assert.equal(v.findings.length, 1, 'a unique root cause key identifies its cluster');
  v = validateScorecardOutput({ findings: [{ cluster: 'review', rootCause: 'incorrect_review', refs: [1], quotes: ['can you help with my withdrawal'], what: 'x' }] }, { track: 'live_chat', refs: r2, evidence: [] });
  assert.equal(v.findings.length, 0, 'client words never count'); assert.ok(v.rejected[0].debug);
  v = validateScorecardOutput({ findings: [{ cluster: 'generic', rootCause: 'unpersonalized_template', refs: [2], quotes: ['Hello! ... Trustpilot if you are satisfied'], what: 'x', why: 'y', recommendation: 'z' }] }, { track: 'live_chat', refs: r2, evidence: [] });
  assert.equal(v.findings.length, 1, 'a quote with an ellipsis matches each part');
}
console.log('scorecards: verifier passed');