import assert from 'node:assert/strict';
import { detectNamedProduct, deterministicPolicyAnswer, explicitHedgingRule, isFnmarketsEvidence, repairHedgingLanguage } from '../lib/policyPrecision.mjs';

const evidence = `At FundedNext, hedging is allowed only within the same account. Hedging across multiple accounts is prohibited.
Copy Trading between multiple accounts that do not belong to the same individual, including relatives, family members, or friends, is strictly prohibited.`;

assert.equal(isFnmarketsEvidence({ article_title: 'FNmarkets FN50 Campaign: Secure Your Free Account', article_url: 'https://help.fundednext.com/en/articles/1' }), true);
assert.equal(isFnmarketsEvidence({ article_title: 'What are the Restricted/Prohibited Trading Strategies?', article_url: 'https://help.fundednext.com/en/articles/8020351' }), false);
assert.equal(detectNamedProduct('How do I deposit with FNmarkets brokerage?'), 'fnmarkets');
assert.equal(detectNamedProduct('What are the FundedNext Futures rules?'), 'futures');
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
console.log('policy precision regression: 12 assertions passed');
