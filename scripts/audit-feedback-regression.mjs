import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditReportTranscript, buildAgentWorkloadLedger, humanEfficiencyComment, scoreEfficiency } from '../lib/auditFeedback.mjs';

const metrics = {
  supportLevel: 'standard', ahtSeconds: 2193, ahtMessageCount: 3, ahtHit: false, ahtTarget: 1200,
  frtSeconds: 24, frtHit: true, frtTarget: 30, artBreaches: 1, artTarget: 90, responseTimes: [45, 112]
};
const feedback = humanEfficiencyComment(metrics);
assert.match(feedback, /36 minutes 33 seconds/);
assert.match(feedback, /FRT was 24 seconds/);
assert.doesNotMatch(feedback, /2193 seconds|deterministic|provided by the system|standard support pacing/i);
assert.match(feedback, /In a similar case/);

const html = auditReportTranscript({
  status: 'completed', conversationId: '123', agentName: 'Jane', model: 'test-model',
  audit: {
    quality: 8, efficiency: 8, complexity: 7, finalScore: 7.67, confidence: 90,
    primaryIssue: 'The answer was accurate but incomplete.', mainFinding: 'Jane explained the rule but did not address the client’s concern.',
    qualityComment: 'The rule was correct. Next time, acknowledge the concern before explaining it.', efficiencyComment: feedback,
    complexityComment: 'Escalate the interface concern with a clear owner and timeframe.', handoffSummary: '', coachingActions: ['Acknowledge the concern first.'], goal: 'Resolve the question and the underlying concern.',
    deductions: [{ category: 'quality', pointsDeducted: 2, reason: 'The reply dismissed the interface concern.', transcriptExample: 'The policy rule is completely correct.', betterAction: 'Acknowledge the concern and explain the next step.' }], accuracyIssues: []
  }, evidence: [], reportTurns: [
    { id: '1', at: 1792220000, kind: 'client', authorName: 'Client', body: 'The dashboard is confusing.\nCan you check it?', partType: 'comment' },
    { id: '2', at: 1792220060, kind: 'agent', authorName: 'Jane', body: 'The policy rule is correct.\nPlease review the dashboard.', partType: 'comment' }
  ]
});
assert.match(html, /Chat transcript/);
assert.match(html, /<details class="transcript">/);
assert.doesNotMatch(html, /<details class="transcript" open/);
assert.match(html, /2 messages · Expand/);
assert.match(html, /The dashboard is confusing\.\nCan you check it\?/);
assert.match(html, /<mark class="flag-quality">The policy rule is correct\.<\/mark>/);
assert.match(html, /Referenced in verdict/);
const auditSource = readFileSync(new URL('../lib/audits.js', import.meta.url), 'utf8');
assert.match(auditSource, /Flagged excerpt:/);
assert.match(auditSource, /Next time:/);
assert.match(auditSource, /Self-assignment is prohibited and automatically sets Efficiency to 0\/10/);
assert.match(auditSource, /Critical workflow violation: The agent assigned this conversation to themselves/);
assert.match(auditSource, /selfAssignmentEventId/);
assert.match(auditSource, /!turn\.assignmentAutomated/, 'automated or balanced assignment cannot trigger self-assignment');
assert.match(auditSource, /balanced\[ _-\]\*assignment/, 'balanced assignment metadata is recognized explicitly');
assert.match(auditSource, /inappropriateBotWarningCount/, 'investigation-status warning violations are measured');
assert.match(auditSource, /within three minutes/, 'investigation-status timing is explicit');
assert.match(auditSource, /investigationOffDelays/, 'chat-holding violations are measured');
assert.match(auditSource, /Review requests belong to Process & Judgment, not Quality/, 'review request cannot reduce Quality');
assert.match(auditSource, /level2_inferred_assignment_reply_intervals/, 'Level 2 AHT survives Intercom assignment events that omit the assignee ID');
assert.match(auditSource, /genericAssignment \|\| \(priorMessage/, 'Level 2 AHT uses a deterministic assignment or preceding-message fallback');
assert.match(auditSource, /level2: Object\.freeze\(\{ frtSeconds: 30, artSeconds: 90, ahtSeconds: 300 \}\)/, 'Level 2 defaults to a five-minute AHT target');
assert.match(auditSource, /audit_efficiency_thresholds_v1/, 'efficiency targets are saved configuration instead of code-only constants');
assert.match(auditSource, /non_overlapping_agent_workload_episode_ledger/, 'AHT uses the non-overlapping workload ledger');
assert.match(auditSource, /wrapUpSeconds/, 'AHT preserves post-reply time through snooze or manual close');
assert.match(auditSource, /L2 Exceptional Cases/, 'approved Level 2 self-assignment queues are exempt');
assert.match(auditSource, /note\|internal/, 'internal notes are excluded from client-visible replies');
assert.match(auditSource, /clarificationFollowUp/, 'a prompt follow-up question does not require investigation status');

const ledger = buildAgentWorkloadLedger([
  { conversationId: 'A', agentId: 'agent', intercomLink: 'https://example/A', cycles: [{ replyId: 'A1', readyAt: 100, replyAt: 210, endAt: 219 }] },
  { conversationId: 'B', agentId: 'agent', intercomLink: 'https://example/B', cycles: [{ replyId: 'B1', readyAt: 180, replyAt: 250, endAt: 266 }] },
  { conversationId: 'A', agentId: 'agent', intercomLink: 'https://example/A', cycles: [{ replyId: 'A2', readyAt: 500, replyAt: 540, endAt: 550 }] }
]);
assert.equal(ledger['A:agent:A1'].startAt, 100, 'first work episode starts when it becomes actionable');
assert.equal(ledger['B:agent:B1'].startAt, 219, 'overlapping work resumes after the preceding handled action');
assert.equal(ledger['B:agent:B1'].previousConversationId, 'A', 'preceding conversation stays traceable');
assert.equal(ledger['A:agent:A2'].startAt, 500, 'idle time before a returning client is excluded');

const level1 = (overrides = {}) => ({
  supportLevel: 'standard', frtSeconds: 30, frtHit: true, ahtSeconds: 1200, ahtHit: true,
  artBreaches: 0, responseTimes: [90], slaStatus: 'hit', ...overrides
});
assert.equal(scoreEfficiency(level1()), 9, 'meeting the target boundary maps to Level 1 score 9');
assert.equal(scoreEfficiency(level1({ frtSeconds: 31, frtHit: false })), 5, 'FRT miss with otherwise controlled handling maps to score 5');
assert.equal(scoreEfficiency(level1({ frtSeconds: 31, frtHit: false, artBreaches: 1, responseTimes: [91] })), 4, 'FRT plus a badly missed ART maps to score 4');
assert.equal(scoreEfficiency(level1({ frtSeconds: 31, frtHit: false, artBreaches: 2, responseTimes: [91, 120] })), 2, 'FRT plus multiple ART misses maps to score 2');
assert.equal(scoreEfficiency(level1({ frtSeconds: 31, frtHit: false, ahtSeconds: 1201, ahtHit: false })), 5, 'minor AHT overage does not create a critical score');
assert.equal(scoreEfficiency(level1({ ahtSeconds: 1201, ahtHit: false })), 8, 'slight AHT overage maps to score 8');
assert.equal(scoreEfficiency(level1({ frtSeconds: 29, ahtSeconds: 1199, responseTimes: [89] })), 10, 'all Level 1 targets strictly beaten maps to score 10');
assert.equal(scoreEfficiency(level1({ frtSeconds: 15, ahtSeconds: 600, responseTimes: [45] })), 10, 'exceptional half-target timing earns 10');
assert.equal(scoreEfficiency(level1({ artBreaches: 1, responseTimes: [45,45,45,45,45,45,45,45,45,91] })), 9, '90% ART maintenance maps to score 9 when AHT is within target');
assert.equal(scoreEfficiency(level1({ artBreaches: 2, responseTimes: [45,45,45,45,45,45,45,45,91,120] })), 9, '80% ART maintenance remains in the approved score-9 band');
assert.equal(scoreEfficiency(level1({ selfAssigned: true })), 0, 'self-assignment overrides every timing result and sets Efficiency to 0');
const selfAssignedFeedback = humanEfficiencyComment(level1({ selfAssigned: true, ahtMessageCount: 2 }));
assert.match(selfAssignedFeedback, /^The agent assigned this conversation to themselves\./);
assert.match(selfAssignedFeedback, /automatically sets Efficiency to 0\/10/);

const pageSource = readFileSync(new URL('../pages/audits.js', import.meta.url), 'utf8');
assert.match(pageSource, /ART breach \$\{index \+ 1\}/);
assert.match(pageSource, /cycle\.breached/);
assert.match(pageSource, /Self-assignment violation/);
assert.match(pageSource, /second: '2-digit'/, 'audit timestamps include seconds');
assert.match(pageSource, /readableEvent/, 'Intercom event markers are presented as readable timeline entries');
assert.match(pageSource, /L2 timing anchor/, 'recovered Level 2 AHT timing is visible to leads in the transcript');

console.log('audit feedback regression: 49 assertions passed');
