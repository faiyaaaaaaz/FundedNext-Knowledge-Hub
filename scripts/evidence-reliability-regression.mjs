import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  asksForPrivateAccountState, buildEmbeddingPlan, evidenceAppliesToProduct,
  evidenceBudgetForTopics, extractAuditEvidenceQueries, focusedEvidenceExcerpt,
  inferConversationProduct, repairPrivateAccountStateClaims
} from '../lib/evidenceReliability.mjs';
import { shouldUseLlmClarifier } from '../lib/query-planning.mjs';

const wrongProduct = evidenceAppliesToProduct({
  title: 'FNmarkets bank payout update', url: 'https://help.fundednext.com/en/articles/1',
  text: 'This update applies to the FNmarkets brokerage wallet.'
}, 'cfd', 'both');
assert.equal(wrongProduct.applies, false, 'source text must override over-broad product metadata');
assert.equal(wrongProduct.inferredProduct, 'fnmarkets');

const correctProduct = evidenceAppliesToProduct({
  title: 'What are the restricted trading strategies?',
  url: 'https://help.fundednext.com/en/articles/8020351', text: 'Rules for Stellar CFD Accounts.'
}, 'cfd', 'both');
assert.equal(correctProduct.applies, true);

const topics = Array.from({ length: 24 }, (_, index) => ({ question: `Question ${index + 1} about policy topic ${index + 1}?`, queries: [`policy topic ${index + 1}`] }));
const plan = buildEmbeddingPlan({ question: 'A long customer message', clearQuestion: 'A long customer message', topics });
for (const topic of topics) assert.ok(plan.includes(topic.question), `embedding plan omitted ${topic.question}`);
assert.ok(plan.length <= 32, 'embedding plan must stay within the bounded parallel-search budget');
assert.equal(evidenceBudgetForTopics(1), 7);
assert.equal(evidenceBudgetForTopics(5), 16);
assert.equal(evidenceBudgetForTopics(24), 20);

const longEvidence = `${'Introductory text with no answer. '.repeat(90)}The maximum daily loss is calculated using equity and balance at the daily reset. ${'Closing text. '.repeat(30)}`;
const excerpt = focusedEvidenceExcerpt(longEvidence, 'How is maximum daily loss calculated?', 500);
assert.match(excerpt, /maximum daily loss is calculated/i, 'focused excerpts must retain a relevant fact found late in an article');

const transcript = [
  '2026-10-20 | CLIENT | Customer: Can I use an EA on my Futures account?',
  '2026-10-20 | AGENT | Agent: Please allow me a moment.',
  '2026-10-20 | CLIENT | Customer: What is the maximum loss limit and can I hold overnight?'
].join('\n');
const auditQueries = extractAuditEvidenceQueries(transcript);
assert.equal(auditQueries.length, 3);
assert.ok(auditQueries.some((query) => /maximum loss limit/i.test(query)));
assert.equal(inferConversationProduct(transcript), 'futures');

assert.equal(asksForPrivateAccountState('Is my account currently in good standing after this warning?'), true);
const repaired = repairPrivateAccountStateClaims('Your account is in good standing. You do not need to take any action.', [
  { question: 'Is my account currently in good standing after this warning?' }
]);
assert.doesNotMatch(repaired, /good standing|do not need to take any action/i);
assert.match(repaired, /cannot verify the current status of your account/i);

assert.equal(shouldUseLlmClarifier({ question: '1. What is FRT?\n2. What is ART?', smartRetrieval: true, conceptGroupCount: 2 }), false,
  'explicit lists use deterministic decomposition instead of a slow lossy helper');
assert.equal(shouldUseLlmClarifier({ question: 'Is hedging allowed?', smartRetrieval: true, conceptGroupCount: 1 }), false,
  'short direct known concepts must not incur a clarification call');

const searchSource = readFileSync(new URL('../pages/api/search.js', import.meta.url), 'utf8');
const auditSource = readFileSync(new URL('../lib/audits.js', import.meta.url), 'utf8');
const noticeSource = readFileSync(new URL('../lib/notices.js', import.meta.url), 'utf8');
assert.match(searchSource, /buildEmbeddingPlan/);
assert.match(searchSource, /answerEvidenceLimit/);
assert.match(searchSource, /focusedEvidenceExcerpt/);
assert.match(searchSource, /repairPrivateAccountStateClaims/);
assert.doesNotMatch(searchSource, /embedTexts[^;]*\.slice\(0,\s*20\)/s, 'late questions cannot be truncated from the embedding plan');
assert.match(auditSource, /extractAuditEvidenceQueries/);
assert.match(auditSource, /evidenceAppliesToProduct/);
assert.match(noticeSource, /evidenceAppliesToProduct/);

console.log('evidence reliability regression: 43 assertions passed');
