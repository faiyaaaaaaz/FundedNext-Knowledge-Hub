import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditReportTranscript, humanEfficiencyComment } from '../lib/auditFeedback.mjs';

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
assert.match(html, /The dashboard is confusing\.\nCan you check it\?/);
assert.match(html, /<mark class="flag-quality">The policy rule is correct\.<\/mark>/);
assert.match(html, /Referenced in verdict/);
const auditSource = readFileSync(new URL('../lib/audits.js', import.meta.url), 'utf8');
assert.match(auditSource, /Flagged excerpt:/);
assert.match(auditSource, /Next time:/);

console.log('audit feedback regression: 12 assertions passed');
