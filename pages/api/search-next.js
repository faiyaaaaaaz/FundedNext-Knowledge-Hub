// ============================================================================
// pages/api/search-next.js
// The Lab answer endpoint. = FAQ retrieval + a higher-authority NOTICES layer.
// Gated to allowlisted emails. Does NOT modify the live /api/search.
// ============================================================================
import {
  authenticateRequest, getKeys, supabaseAdmin, openaiEmbed,
  openaiChatDetailed, getPrompt, getBrandingRules, brandingInstructions,
  applyBrandingReplacements
} from '../../lib/server';
import { isNoticeLabUser, retrieveNotices } from '../../lib/notices';

export const config = { maxDuration: 60 };

const SAFE_UNCONFIRMED = 'I’m unable to confirm this accurately right now. Please allow me some time to verify it for you.';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (!(await isNoticeLabUser(access))) return res.status(403).json({ error: 'The Lab is not enabled for your account.' });

    const question = String(req.body?.question || '').trim().slice(0, 20000);
    if (!question) return res.status(400).json({ error: 'Please type a question.' });

    const { openaiKey, groqKey, chatModel, chatProvider } = await getKeys();
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key is saved yet.' });

    const sb = supabaseAdmin();
    const product = ['cfd', 'futures', 'both'].includes(req.body?.scope?.product) ? req.body.scope.product : 'both';
    const model = String(req.body?.scope?.model || 'all');

    // 1) NOTICES — the priority layer
    const { matches: noticeMatches, escalations } = await retrieveNotices(sb, { openaiKey, question, product, model, limit: 6 });

    // 2) FAQ — the base layer (existing match_chunks)
    let faq = [];
    try {
      const [vec] = await openaiEmbed(openaiKey, [question]);
      const vres = await sb.rpc('match_chunks', { query_embedding: vec, match_threshold: 0.14, match_count: 10 });
      faq = vres.data || [];
    } catch (e) { /* ignore */ }

    if (!noticeMatches.length && !faq.length) {
      return res.status(200).json({ answer: SAFE_UNCONFIRMED, sources: [], escalations: [] });
    }

    const noticeBlock = noticeMatches
      .map((m, i) => `[N${i + 1}] ${m.meta.title} (effective ${String(m.meta.posted_at || '').slice(0, 10)})\n${m.meta.answer_text}`)
      .join('\n\n');
    const faqBlock = faq
      .map((f, i) => `[F${i + 1}] ${f.article_title}\n${f.content}`)
      .join('\n\n---\n\n');

    const [basePrompt, brandRules] = await Promise.all([getPrompt(), getBrandingRules()]);
    const system = basePrompt + brandingInstructions(brandRules) +
      '\n\nYou are given two evidence sources. CURRENT OPERATIONAL NOTICES carry the latest policy and OVERRIDE any conflicting FAQ EVIDENCE. If two notices conflict, the later effective date wins. Do not mention notices, FAQs, sources, escalation, or internal routing in your reply. Write only the customer-ready answer. If neither source supports the question, reply exactly: "' + SAFE_UNCONFIRMED + '"';

    const userMsg =
      `Customer question: ${question}\n\n` +
      `CURRENT OPERATIONAL NOTICES (highest authority):\n${noticeBlock || '(none)'}\n\n` +
      `FAQ EVIDENCE (use only if not contradicted by a notice):\n${faqBlock || '(none)'}`;

    const messages = [{ role: 'system', content: system }, { role: 'user', content: userMsg }];

    // Provider: mirror the app's setting; simple fallback to OpenAI gpt-4o.
    let completion, answerProvider = 'openai';
    if (chatProvider === 'groq' && groqKey) {
      try {
        completion = await openaiChatDetailed(groqKey, chatModel, messages, 'https://api.groq.com/openai/v1');
        answerProvider = 'groq';
      } catch (e) {
        completion = await openaiChatDetailed(openaiKey, 'gpt-4o', messages);
      }
    } else {
      const m = (chatProvider === 'openai' && chatModel) ? chatModel : 'gpt-4o';
      completion = await openaiChatDetailed(openaiKey, m, messages);
    }

    const answer = applyBrandingReplacements(String(completion.content || '').trim(), brandRules) || SAFE_UNCONFIRMED;

    const sources = [
      ...noticeMatches.map((m) => ({ kind: 'notice', title: m.meta.title, url: m.meta.source_url, posted_by: m.meta.posted_by, posted_at: m.meta.posted_at })),
      ...faq.slice(0, 3).map((f) => ({ kind: 'faq', title: f.article_title, url: f.article_url }))
    ];

    return res.status(200).json({ answer, sources, escalations, answerProvider });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
