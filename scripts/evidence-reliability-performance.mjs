import assert from 'node:assert/strict';
import { buildEmbeddingPlan, evidenceRelevanceScore, focusedEvidenceExcerpt } from '../lib/evidenceReliability.mjs';

const topics = Array.from({ length: 24 }, (_, index) => ({ question: `Question ${index + 1}: explain rule ${index + 1}?`, queries: [`rule ${index + 1}`] }));
const sources = Array.from({ length: 200 }, (_, index) => ({
  title: `Policy article ${index + 1}`,
  text: `${'General policy details. '.repeat(80)} Rule ${index % 24 + 1} applies under the stated account conditions. ${'Additional conditions. '.repeat(40)}`
}));

const started = performance.now();
for (let iteration = 0; iteration < 100; iteration += 1) {
  const plan = buildEmbeddingPlan({ question: 'Long policy request', topics });
  for (const source of sources) evidenceRelevanceScore(source, plan);
  for (const source of sources.slice(0, 20)) focusedEvidenceExcerpt(source.text, topics[iteration % topics.length].question, 1200);
}
const elapsedMs = performance.now() - started;
assert.ok(elapsedMs < 2500, `local evidence planning took ${elapsedMs.toFixed(1)}ms; expected under 2500ms`);
console.log(`evidence reliability performance: ${elapsedMs.toFixed(1)}ms for 100 long-query planning passes`);
