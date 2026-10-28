import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectNamedProduct, deterministicPolicyAnswer, explicitHedgingRule, isFnmarketsEvidence, repairHedgingLanguage } from '../lib/policyPrecision.mjs';

const evidence = `At FundedNext, hedging is allowed only within the same account. Hedging across multiple accounts is prohibited.
Copy Trading between multiple accounts that do not belong to the same individual, including relatives, family members, or friends, is strictly prohibited.`;

assert.equal(isFnmarketsEvidence({ article_title: 'FNmarkets FN50 Campaign: Secure Your Free Account', article_url: 'https://help.fundednext.com/en/articles/1' }), true);
assert.equal(isFnmarketsEvidence({ article_title: 'What are the Restricted/Prohibited Trading Strategies?', article_url: 'https://help.fundednext.com/en/articles/8020351' }), false);
assert.equal(detectNamedProduct('How do I deposit with FNmarkets brokerage?'), 'fnmarkets');
assert.equal(detectNamedProduct('What are the FundedNext Futures rules?'), 'futures');
assert.equal(detectNamedProduct('Can I use FNL:004 Labs with Duplikium?'), 'futures');
assert.equal(explicitHedgingRule(evidence), true);
assert.match(deterministicPolicyAnswer('Is hedging allowed?', evidence).answer, /allowed when both opposing positions.*same FundedNext account/is);
assert.match(deterministicPolicyAnswer('My friend and I will place matching trades on our separate accounts.', evidence).answer, /prohibited copy trading/i);
assert.match(deterministicPolicyAnswer('I will place buy positions on XAUUSD while my friend places short positions. One side is bound to win.', evidence).answer, /group hedging refers to opposite positions/i);
const multiPolicyAnswer = deterministicPolicyAnswer('Can my friend buy XAUUSD while I buy it too, and is hedging allowed inside my own account?', evidence).answer;
assert.match(multiPolicyAnswer, /same FundedNext account/i);
assert.match(multiPolicyAnswer, /prohibited copy trading/i);
const repaired = repairHedgingLanguage('Prohibited practices include:\n\nGroup Hedging or Hedging\n\nArbitrage', evidence);
assert.match(repaired, /hedging across multiple accounts/i);
assert.match(repaired, /Hedging within the same account is allowed/i);
const searchSource = readFileSync(new URL('../pages/api/search.js', import.meta.url), 'utf8');
const candidateDeclaration = searchSource.indexOf('let candidates =');
const matchDeclaration = searchSource.indexOf('let matches;');
const policyReservation = searchSource.indexOf('// Reserve the exact policy passage');
assert.ok(candidateDeclaration >= 0 && matchDeclaration >= 0 && policyReservation > candidateDeclaration && policyReservation > matchDeclaration,
  'Policy evidence reservation must run after candidates and matches are initialized.');
assert.match(searchSource, /policyResult && topicPlan\.length === 1/, 'a single policy repair cannot replace an entire multi-question answer');
assert.match(searchSource, /reconcileMultiQuestionCoverage\(topicPlan, coverageStatuses, answer\)/, 'multi-question coverage is checked against the visible answer');
assert.match(searchSource, /doubleUp:\s*\/\\bdouble/, 'Double Up questions receive a dedicated retrieval intent');
assert.match(searchSource, /second Challenge Account/, 'Double Up retrieval reserves the canonical timing evidence');
assert.match(searchSource, /explicitlyProductWide/, 'all-model scope retains FAQs that explicitly apply to all accounts');
assert.match(searchSource, /answerEchoesQuestion/, 'question-shaped model output is detected and recovered or rejected');
assert.doesNotMatch(searchSource.match(/function verifiedSourceGapAnswer[\s\S]*?\n}/)?.[0] || '', /conciseQuestionLabel/, 'source-gap messages do not repeat the customer question');
console.log('policy precision regression: 21 assertions passed');
