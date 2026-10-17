import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditReportTranscript, humanEfficiencyComment, scoreEfficiency } from '../lib/auditFeedback.mjs';

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

const level1 = (overrides = {}) => ({
  supportLevel: 'standard', frtSeconds: 30, frtHit: true, ahtSeconds: 1200, ahtHit: true,
  artBreaches: 0, responseTimes: [90], slaStatus: 'hit', ...overrides
});
assert.equal(scoreEfficiency(level1()), 8, 'meeting all Level 1 thresholds is the benchmark 8');
assert.equal(scoreEfficiency(level1({ frtSeconds: 31, frtHit: false })), 2, 'FRT miss alone sets the score to 2');
assert.equal(scoreEfficiency(level1({ frtSeconds: 31, frtHit: false, artBreaches: 1, responseTimes: [91] })), 0, 'FRT plus ART miss sets the score to 0');
assert.equal(scoreEfficiency(level1({ frtSeconds: 31, frtHit: false, ahtSeconds: 1201, ahtHit: false })), 0, 'FRT plus AHT miss sets the score to 0');
assert.equal(scoreEfficiency(level1({ ahtSeconds: 1201, ahtHit: false })), 8, 'AHT miss alone retains the benchmark score when FRT and ART pass');
assert.equal(scoreEfficiency(level1({ frtSeconds: 29, ahtSeconds: 1199, responseTimes: [89] })), 9, 'beating every target earns more than 8');
assert.equal(scoreEfficiency(level1({ frtSeconds: 15, ahtSeconds: 600, responseTimes: [45] })), 10, 'exceptional half-target timing earns 10');
assert.equal(scoreEfficiency(level1({ artBreaches: 1, responseTimes: [91] })), 6, 'one ART-only miss is a limited deduction');
assert.equal(scoreEfficiency(level1({ artBreaches: 2, responseTimes: [91, 120] })), 4, 'repeated ART-only misses receive a larger deduction');
assert.equal(scoreEfficiency(level1({ selfAssigned: true })), 0, 'self-assignment overrides every timing result and sets Efficiency to 0');
const selfAssignedFeedback = humanEfficiencyComment(level1({ selfAssigned: true, ahtMessageCount: 2 }));
assert.match(selfAssignedFeedback, /^The agent assigned this conversation to themselves\./);
assert.match(selfAssignedFeedback, /automatically sets Efficiency to 0\/10/);

const pageSource = readFileSync(new URL('../pages/audits.js', import.meta.url), 'utf8');
assert.match(pageSource, /ART breach \$\{index \+ 1\}/);
assert.match(pageSource, /cycle\.breached/);
assert.match(pageSource, /Self-assignment violation/);

console.log('audit feedback regression: 30 assertions passed');
