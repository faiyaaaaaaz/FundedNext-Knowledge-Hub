import assert from 'node:assert/strict';
import { articleProduct, isLocalizedTitle, splitQuestions, mergeChunks, rankArticles, plainText, sanitizeLinks, answerFromArticles } from '../lib/directAnswer.mjs';

// products and localization
assert.equal(articleProduct('https://helpfutures.fundednext.com/en/articles/1-x', 'Anything'), 'futures');
assert.equal(articleProduct('http://help.fnmarkets.com/en/articles/2-x', 'x'), 'fnmarkets');
assert.equal(articleProduct('https://help.fundednext.com/en/articles/3-x', "What is FundedNext Futures' Brand Promise?"), 'futures');
assert.equal(articleProduct('https://help.fundednext.com/en/articles/4-x', 'What is the refund policy of FundedNext?'), 'cfd');
assert.equal(isLocalizedTitle('[FA] چگونه'), true); assert.equal(isLocalizedTitle('How do I log in?'), false);

// question splitting
assert.deepEqual(splitQuestions('how long do refunds take'), ['how long do refunds take']);
const many = splitQuestions('1) What is the daily loss limit?\n2) Can I use an EA? Is copy trading allowed?\n- What is the minimum payout?');
assert.equal(many.length, 4); assert.ok(many[0].startsWith('What is the daily loss'));

// chunk merge removes the overlap and keeps tables
assert.equal(mergeChunks(['AAAA first part that ends with the overlap sentence here.', 'with the overlap sentence here. and then continues.']), 'AAAA first part that ends with the overlap sentence here. and then continues.');

// ranking: product filter, localized exclusion, duplicate titles, title boost
const rows = [
  { article_id: '10', article_title: 'What is the refund policy of FundedNext?', article_url: 'https://help.fundednext.com/en/articles/10-a', similarity: 0.55, content: 'refund text' },
  { article_id: '11', article_title: 'What happens if the referred customer requests a refund?', article_url: 'https://helpfutures.fundednext.com/en/articles/11-a', similarity: 0.7, content: 'x' },
  { article_id: '12', article_title: '[FA] سیاست بازپرداخت', article_url: 'https://help.fundednext.com/en/articles/12-a', similarity: 0.9, content: 'x' },
  { article_id: '13', article_title: 'What is the refund policy of FundedNext?', article_url: 'https://help.fundednext.com/en/articles/13-a', similarity: 0.5, content: 'dup' },
  { article_id: '14', article_title: 'How do overnight refunds work', article_url: 'https://help.fundednext.com/en/articles/14-a', similarity: 0.52, content: 'o' }
];
const ranked = rankArticles(rows, { product: 'cfd', question: 'how long does a refund take', limit: 5 });
assert.deepEqual(ranked.map((item) => item.id), ['10', '14']);
assert.equal(rankArticles(rows, { product: 'futures', question: 'refund', limit: 5 })[0].id, '11');

// plain text and links
assert.equal(plainText('**Bold** point\n\n1. First\n2. Second\n- bullet'), 'Bold point\n\n1) First\n2) Second\nbullet');
const linked = sanitizeLinks('See [Real](https://help.fundednext.com/en/articles/10-a) and [Fake](https://evil.example/x) and https://help.fundednext.com/en/ done', new Set(['https://help.fundednext.com/en/articles/10-a']));
assert.ok(linked.answer.includes('[Real](https://help.fundednext.com/en/articles/10-a)'));
assert.ok(!linked.answer.includes('evil.example')); assert.equal(linked.removed.length, 2);

// full flow with fakes
const chunkRows = [
  { article_id: '10', chunk_index: 0, content: 'FundedNext offers a refund option if trading has not been initiated within 7 days of registering.' },
  { article_id: '14', chunk_index: 0, content: 'Overnight refunds are credited to your account.' }
];
const fakeSb = {
  rpc: async () => ({ data: rows }),
  from: () => { const q = { select: () => q, in: () => q, order: () => q, limit: async () => ({ data: chunkRows }) }; return q; }
};
let seenPrompt = '';
const out = await answerFromArticles({
  sb: fakeSb, question: 'how long does it take after i submit a refund request', product: 'cfd', modelLabel: 'All CFD models',
  embed: async (texts) => texts.map(() => [0.1]),
  chat: async (messages) => { seenPrompt = messages[1].content; return { content: 'A refund is available if trading has not been initiated within 7 days of registering. The published articles do not state how long a refund takes to arrive after you submit the request.\n\nFor more details, you can read the article [What is the refund policy of FundedNext?](https://help.fundednext.com/en/articles/10-a).', usage: { prompt_tokens: 100 } }; }
});
assert.ok(out.answer.includes('7 days')); assert.equal(out.sources.length, 1); assert.equal(out.sources[0].title, 'What is the refund policy of FundedNext?');
assert.ok(!seenPrompt.includes('referred customer')); assert.ok(!seenPrompt.includes('helpfutures'));
assert.ok(out.confidence < 85 && out.confidence >= 65, 'a stated gap lowers confidence: ' + out.confidence);
assert.equal(out.confidenceReasons.some((item) => item.code === 'gap_stated'), true);
assert.deepEqual(out.segments.map((item) => item.refs), [[], [1]]);

// invented number and invented link are caught
const bad = await answerFromArticles({
  sb: fakeSb, question: 'refund time?', product: 'cfd', embed: async (t) => t.map(() => [0.1]),
  chat: async () => ({ content: 'Refunds take 14 days. See [Policy](https://evil.example/p).' })
});
assert.ok(!bad.answer.includes('evil.example')); assert.ok(bad.confidence < 65); assert.equal(bad.sources.length, 0);

// nothing found -> null so the previous pipeline can run
assert.equal(await answerFromArticles({ sb: { rpc: async () => ({ data: [] }), from: () => ({}) }, question: 'xyz', embed: async (t) => t.map(() => [0]), chat: async () => ({ content: 'x' }) }), null);
console.log('direct answer: all scenarios passed');
// multi-question: each sub-question keeps its own best article even when another topic dominates the overall ranking
{
  let call = 0;
  const mk = (id, title, sim) => ({ article_id: id, article_title: title, article_url: `https://help.fundednext.com/en/articles/${id}-x`, similarity: sim, content: title });
  const perCall = [
    [mk('1', 'Daily loss limit rules', 0.9), mk('2', 'Copy trading rules', 0.85)],
    [mk('1', 'Daily loss limit rules', 0.9)],
    [mk('2', 'Copy trading rules', 0.8)],
    [mk('9', 'What is the refund policy of FundedNext?', 0.6), mk('1', 'Daily loss limit rules', 0.3)]
  ];
  const sb2 = { rpc: async () => ({ data: perCall[Math.min(call++, perCall.length - 1)] }), from: () => { const q = { select: () => q, in: () => q, order: () => q, limit: async () => ({ data: [] }) }; return q; } };
  let sent = '';
  const out2 = await answerFromArticles({ sb: sb2, question: '1) What is the daily loss limit?\n2) Is copy trading allowed?\n3) What is the refund policy?', product: 'cfd', embed: async (t) => t.map(() => [0.1]), chat: async (m) => { sent = m[1].content; return { content: 'ok [Policy](https://help.fundednext.com/en/articles/9-x)' }; } });
  assert.ok(sent.includes('What is the refund policy of FundedNext?'), 'the refund article reaches the model');
  assert.ok(out2.sources.some((s) => s.url.includes('/9-x')));
}
console.log('direct answer: multi-question selection passed');