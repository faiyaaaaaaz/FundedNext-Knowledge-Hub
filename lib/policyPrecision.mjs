export const PRODUCT_SCOPES = ['cfd', 'futures', 'fnmarkets', 'both'];

export function isFnmarketsEvidence(item = {}) {
  const url = String(item.article_url || item.url || '').toLowerCase();
  const title = String(item.article_title || item.title || '').replace(/[\u200B-\u200F\uFEFF]/g, ' ');
  return /(?:^|\.)help\.fnmarkets\.com$/i.test((() => { try { return new URL(url).hostname; } catch { return ''; } })()) ||
    /\bfn\s*markets\b/i.test(title);
}

export function detectNamedProduct(text) {
  const value = String(text || '').replace(/[\u200B-\u200F\uFEFF]/g, ' ');
  if (/\bfn\s*markets\b|\bbrokerage\b/i.test(value)) return 'fnmarkets';
  if (/\bfundednext\W*futures\b|\bfutures\W+(?:account|challenge|model|rules?)\b/i.test(value)) return 'futures';
  return null;
}

export function policyPrecisionIntent(text) {
  const value = String(text || '').toLowerCase();
  const hedging = /\bhedg(?:e|ed|es|ing)\b/.test(value);
  const differentOwners = /\b(?:friend|family|relative|colleague|another person|someone else|different (?:person|owner)|not (?:my|mine))\b/.test(value);
  const coordinatedTrade = /\b(?:same|matching|identical|copy|coordinate|coordinated|together|opposite)\b.{0,55}\b(?:trades?|positions?|orders?|instruments?|pairs?|symbols?|assets?)\b|\b(?:trades?|positions?|orders?)\b.{0,55}\b(?:same|matching|identical|copy|coordinate|coordinated|together|opposite)\b/.test(value) ||
    /\b(?:buy|sell|long|short)\b.{0,80}\b(?:too|also|same|matching|opposite|while)\b|\bwhile\b.{0,80}\b(?:buy|sell|long|short)\b/.test(value);
  const asksPermission = /\b(?:is|are|can|could|may|allowed|permitted|prohibited|banned)\b/.test(value);
  const prohibitedOverview = /\b(?:prohibited|restricted|banned|not allowed)\b.{0,35}\b(?:strateg|practic|trading|activit)/.test(value);
  return { hedging, differentOwners, coordinatedTrade, asksPermission, prohibitedOverview, friendCoordination: differentOwners && coordinatedTrade };
}

export function explicitHedgingRule(text) {
  const value = String(text || '').replace(/\s+/g, ' ').toLowerCase();
  return /hedging.{0,90}allowed.{0,70}(?:same|one) account|allowed.{0,70}(?:same|one) account.{0,90}hedging/.test(value) &&
    /hedging.{0,100}(?:multiple|different|various) accounts?.{0,80}(?:prohibited|not allowed)|(?:prohibited|not allowed).{0,80}hedging.{0,100}(?:multiple|different|various) accounts?/.test(value);
}

export function explicitDifferentOwnerCopyRule(text) {
  const value = String(text || '').replace(/\s+/g, ' ').toLowerCase();
  return /copy trading/.test(value) && /(?:friend|family|relative|not (?:belong|owned)|different (?:person|owner)|multiple accounts)/.test(value) && /(?:prohibited|not allowed|strictly)/.test(value);
}

export function deterministicPolicyAnswer(question, evidenceText) {
  const intent = policyPrecisionIntent(question);
  if (intent.hedging && intent.friendCoordination && explicitHedgingRule(evidenceText) && explicitDifferentOwnerCopyRule(evidenceText)) {
    return {
      kind: 'hedging-and-different-owner-copying',
      answer: 'Hedging is allowed when both opposing positions are placed within the same FundedNext account. Hedging or group hedging across multiple accounts is prohibited.\n\nYou and your friend also cannot coordinate or mirror trades across accounts owned by different people. Matching trades between separately owned accounts—including accounts belonging to friends or family—are treated as prohibited copy trading. If both accounts take the same direction, that is copy trading or coordinated trading, not hedging.'
    };
  }
  if (intent.hedging && intent.asksPermission && explicitHedgingRule(evidenceText)) {
    return {
      kind: 'hedging',
      answer: 'Yes—hedging is allowed when both opposing positions are placed within the same FundedNext account.\n\nHedging or group hedging across multiple accounts is prohibited. For example, opening a buy position on one account and the corresponding sell position on another account is not allowed.'
    };
  }
  if (intent.friendCoordination && explicitDifferentOwnerCopyRule(evidenceText)) {
    return {
      kind: 'different-owner-copying',
      answer: 'No. You and your friend cannot coordinate or mirror trades across accounts owned by different people. Matching trades between separately owned accounts—including accounts belonging to friends or family—are treated as prohibited copy trading.\n\nIf both accounts take the same direction, that is not hedging. Group hedging refers to opposite positions placed across multiple accounts; that is also prohibited.'
    };
  }
  return null;
}

export function repairHedgingLanguage(answer, evidenceText) {
  let value = String(answer || '');
  if (!value || !explicitHedgingRule(evidenceText) || !/\bhedg/i.test(value)) return value;
  value = value
    .replace(/\bgroup hedging\s+or\s+hedging\b(?!\s+across)/gi, 'group hedging or hedging across multiple accounts')
    .replace(/\b(?:FundedNext\s+)?(?:strictly\s+)?prohibits?\s+hedging\b(?!\s+(?:or group hedging )?across)/gi, (match) => `${match} across multiple accounts`)
    .replace(/\bhedging\s+is\s+(?:strictly\s+)?prohibited\b(?!\s+across)/gi, 'hedging across multiple accounts is prohibited');
  if (!/hedging.{0,80}(?:same|one) account.{0,45}allowed|allowed.{0,45}hedging.{0,80}(?:same|one) account/i.test(value)) {
    value += '\n\nHedging within the same account is allowed. Hedging or group hedging across multiple accounts is prohibited.';
  }
  return value;
}
