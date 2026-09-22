import {
  authenticateRequest, supabaseAdmin, getKeys, openaiEmbed,
  openaiChatDetailed, getBrandingRules, brandingInstructions, logActivity, modelsMentioned
} from '../../lib/server';
import { retrieveNotices } from '../../lib/notices';

function parseJson(content) {
  const cleaned = String(content || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('The AI did not return a usable snippet.');
    return JSON.parse(match[0]);
  }
}

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended.' });
    const sb = supabaseAdmin();

    if (req.method === 'POST') {
      const body = req.body || {};
      const reason = String(body.reason || '').trim();
      if (reason.length < 10) return res.status(400).json({ error: 'Please explain the problem in at least 10 characters.' });
      if (!String(body.question || '').trim() || !String(body.answer || '').trim()) {
        return res.status(400).json({ error: 'The question and answer are required.' });
      }
      const selectedScope = body.scope && ['cfd', 'futures', 'both'].includes(body.scope.product)
        ? { type: 'answer_scope', product: body.scope.product, model: String(body.scope.model || 'all'), label: String(body.scope.label || '').slice(0, 160), title: `Answer scope: ${body.scope.product.toUpperCase()} Â· ${String(body.scope.label || body.scope.model || 'All models').slice(0, 160)}`, url: '' }
        : null;
      const recordedSources = Array.isArray(body.sources) ? body.sources.slice(0, 30) : [];
      if (selectedScope) recordedSources.unshift(selectedScope);
      const { data, error } = await sb.from('disputes').insert({
        actor_role: access.role,
        session_id: access.sessionId,
        user_name: access.name || null,
        user_email: access.email || null,
        question: String(body.question).trim(),
        answer: String(body.answer).trim(),
        dispute_reason: reason,
        confidence: Number.isFinite(Number(body.confidence)) ? Number(body.confidence) : null,
        provider: body.provider || null,
        sources: recordedSources
      }).select().single();
      if (error) throw error;
      await logActivity({
        actorRole: access.role, sessionId: access.sessionId,
        userName: access.name, userEmail: access.email, authProvider: access.authProvider,
        eventType: 'dispute',
        provider: body.provider, metadata: { disputeId: data.id, question: String(body.question).slice(0, 4000), questionPreview: String(body.question).slice(0, 180), selectedScope }
      });
      return res.status(200).json({ dispute: data });
    }

    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    if (req.method === 'GET') {
      let query = sb.from('disputes').select('*').order('created_at', { ascending: false }).limit(300);
      if (req.query.status) query = query.eq('status', req.query.status);
      const { data, error } = await query;
      if (error) throw error;
      const rows = data || [];
      const disputeIds = rows.map((item) => item.id);
      let linked = new Map();
      if (disputeIds.length) {
        const { data: snippets, error: snippetError } = await sb.from('ai_snippets').select('id,source_dispute_id,title,trigger_terms,instruction,active,created_at').in('source_dispute_id', disputeIds);
        if (snippetError) throw snippetError;
        linked = new Map((snippets || []).map((item) => [String(item.source_dispute_id), item]));
      }
      return res.status(200).json({ disputes: rows.map((item) => ({
        ...item,
        linked_snippet: linked.get(String(item.id)) || null,
        snippet_missing: item.status === 'snippet_generated' && !linked.has(String(item.id))
      })) });
    }

    if (req.method === 'PATCH') {
      const { id, action, approvalReason } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Dispute ID is required.' });
      const { data: dispute, error: readError } = await sb.from('disputes').select('*').eq('id', id).single();
      if (readError || !dispute) throw readError || new Error('Dispute not found.');

      if (action === 'approve' || action === 'reject') {
        const reason = String(approvalReason || '').trim();
        if (reason.length < 5) return res.status(400).json({ error: 'Please enter your review reason.' });
        const { data, error } = await sb.from('disputes').update({
          status: action === 'approve' ? 'approved' : 'rejected',
          approval_reason: reason,
          reviewed_at: new Date().toISOString()
        }).eq('id', id).select().single();
        if (error) throw error;
        await logActivity({actorRole:access.role,userEmail:access.email,userName:access.name,sessionId:access.sessionId,eventType:'dispute_review',success:true,metadata:{disputeId:id,status:data.status,reason}});
        return res.status(200).json({ dispute: data });
      }

      if (action === 'reset-snippet') {
        const { data: snippets, error: snippetError } = await sb.from('ai_snippets').select('id').eq('source_dispute_id', dispute.id);
        if (snippetError) throw snippetError;
        if ((snippets || []).length) return res.status(409).json({ error: 'A linked snippet still exists. Delete it from Snippets first.' });
        const { data, error } = await sb.from('disputes').update({
          status: 'approved', generated_title: null, generated_trigger_terms: null,
          generated_snippet: null, generated_at: null
        }).eq('id', id).select().single();
        if (error) throw error;
        await logActivity({actorRole:access.role,userEmail:access.email,userName:access.name,sessionId:access.sessionId,eventType:'dispute_review',success:true,metadata:{disputeId:id,status:'approved',reason:'Missing deleted snippet restored to approved'}});
        return res.status(200).json({ dispute: data });
      }

      if (action === 'generate') {
        if (!['approved', 'snippet_generated'].includes(dispute.status)) return res.status(400).json({ error: 'Approve the dispute before generating a correction draft.' });
        const { openaiKey } = await getKeys();
        if (!openaiKey) throw new Error('OpenAI key is required to verify FAQs and Notices.');
        const { data: linkedSnippets, error: linkedError } = await sb.from('ai_snippets').select('*').eq('source_dispute_id', dispute.id);
        if (linkedError) throw linkedError;
        const linkedSnippet = (linkedSnippets || [])[0] || null;
        const recordedScope = (dispute.sources || []).find((item) => item?.type === 'answer_scope');
        const product = ['cfd', 'futures', 'both'].includes(recordedScope?.product) ? recordedScope.product : 'both';
        const model = String(recordedScope?.model || 'all');
        const evidenceQueries = [...new Set([
          dispute.question,
          `${dispute.question} ${dispute.dispute_reason || ''}`,
          `${dispute.question} ${dispute.approval_reason || ''}`,
          linkedSnippet ? `${linkedSnippet.title || ''} ${linkedSnippet.trigger_terms || ''} ${linkedSnippet.instruction || ''}` : ''
        ].map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 4);
        const vectors = await openaiEmbed(openaiKey, evidenceQueries);
        const faqById = new Map();
        for (const vector of vectors) {
          const result = await sb.rpc('match_chunks', { query_embedding: vector, match_threshold: 0.12, match_count: 16 });
          if (result.error) throw result.error;
          for (const item of result.data || []) {
            const key = String(item.id || `${item.article_id}:${item.chunk_index || ''}`);
            const previous = faqById.get(key);
            if (!previous || Number(item.similarity || 0) > Number(previous.similarity || 0)) faqById.set(key, item);
          }
        }
        const questionUsesLocalizedScript = /[\u0600-\u06ff\u0750-\u077f\u3040-\u30ff\u3400-\u9fff\u0400-\u04ff]/.test(dispute.question || '');
        const scopedCandidates = [...faqById.values()].filter((item) => {
          const url = String(item.article_url || '');
          const correctProduct = !recordedScope || recordedScope.product === 'both' || (recordedScope.product === 'futures' ? /helpfutures\.fundednext\.com/i.test(url) : /help\.fundednext\.com/i.test(url));
          if (!correctProduct) return false;
          if (/^\[[A-Z]{2}\]/i.test(String(item.article_title || '').trim()) && !questionUsesLocalizedScript) return false;
          const namedModels = modelsMentioned(`${item.article_title || ''}\n${item.content || ''}`);
          if (model === 'all') return namedModels.length === 0;
          return !namedModels.length || namedModels.some((itemModel) => itemModel.slug === model);
        }).sort((a, b) => Number(b.similarity || 0) - Number(a.similarity || 0));
        const perArticleCount = new Map();
        const scopedEvidence = scopedCandidates.filter((item) => {
          const key = String(item.article_id || item.id || '');
          const count = perArticleCount.get(key) || 0;
          if (count >= 2) return false;
          perArticleCount.set(key, count + 1);
          return true;
        }).slice(0, 12);
        const noticeSearch = [dispute.question, dispute.dispute_reason, dispute.approval_reason, linkedSnippet?.instruction].filter(Boolean).join('\n');
        const noticeResult = await retrieveNotices(sb, { openaiKey, question: noticeSearch, product, model, limit: 6 });
        const noticeEvidence = (noticeResult.matches || []).slice(0, 6);
        const evidence = [
          ...scopedEvidence.map((item, index) => `[FAQ ${index + 1}] ${item.article_title}\nURL: ${item.article_url || 'not recorded'}\n${item.content}`),
          ...noticeEvidence.map((item, index) => `[NOTICE ${index + 1}] ${item.meta?.title || item.article_title}\nPosted: ${item.meta?.posted_at || 'date not recorded'}\nURL: ${item.meta?.source_url || item.article_url || 'not recorded'}\n${item.meta?.answer_text || item.content}`)
        ].join('\n\n---\n\n');
        const capturedAt = new Date().toISOString();
        const correctionEvidence = scopedEvidence.slice(0, 16).map((item) => ({
          type: 'correction_evidence', kind: 'faq', id: item.article_id || item.id,
          title: item.article_title || 'Untitled FAQ', url: item.article_url || '',
          excerpt: String(item.content || '').slice(0, 2400), capturedAt
        })).concat(noticeEvidence.map((item) => ({
          type: 'correction_evidence', kind: 'notice', id: item.article_id,
          title: item.meta?.title || item.article_title || 'Untitled Notice',
          url: item.meta?.source_url || item.article_url || '',
          excerpt: String(item.meta?.answer_text || item.content || '').slice(0, 2400),
          postedAt: item.meta?.posted_at || null, manuallyEntered: item.meta?.source_type === 'manual' || item.meta?.source_type === 'paste', capturedAt
        })));
        const rules = await getBrandingRules();
        const system =
          'You are creating a permanent corrective instruction for a support-answering AI. ' +
          'The disputed answer is the claim under review, not the default truth. First identify the exact correction asserted by the Agent dispute reason and Admin approval reason, including whether it concerns one account, multiple accounts, one phase, or later phases. ' +
          'Re-check every supplied FAQ passage and Notice. The Agent/Admin correction is not authoritative unless the fresh evidence directly supports it. ' +
          'Never produce a correction that merely repeats the material claim being disputed. Never collapse "each EA must use a distinct strategy" into "only one EA or one strategy is allowed" unless the evidence explicitly says that. Preserve account, phase, EA, strategy, instrument, and copy-trading distinctions exactly. ' +
          'A relevant newer Notice overrides an older FAQ only when it applies to the same product, Account model, region, date, and condition. Never merge incompatible rules. ' +
          'If the correction is unsupported, conflicts with the evidence, or addresses a different scenario than the original question, do not draft a snippet. Return {"decision":"needs_review","review_note":"specific reason","title":"","trigger_terms":"","instruction":""}. ' +
          'Otherwise return strict JSON with {"decision":"draft","review_note":"","title":"...","trigger_terms":"...","instruction":"..."}. ' +
          'trigger_terms must be a comma-separated list. instruction must be concise, unambiguous, product-scoped, ' +
          'and state what the AI must and must not do in future answers.' + brandingInstructions(rules);
        const user =
          `Original question:\n${dispute.question}\n\nDisputed answer:\n${dispute.answer}\n\n` +
          `Recorded answer scope:\n${recordedScope ? `${recordedScope.product.toUpperCase()} Â· ${recordedScope.label || recordedScope.model}` : 'Legacy dispute â€” scope was not recorded'}\n\n` +
          `Agent dispute reason:\n${dispute.dispute_reason}\n\nAdmin approval reason:\n${dispute.approval_reason}\n\n` +
          `Currently active correction, if any:\n${linkedSnippet?.instruction || 'None'}\n\n` +
          `Fresh FAQ and Notice evidence:\n${evidence || 'No matching FAQ or Notice evidence was found. Do not invent a correction.'}`;
        // Correction drafting is a low-volume, high-impact Admin action. Use the
        // stronger verifier directly instead of inheriting the fast answering
        // model, which previously restated the disputed answer as a correction.
        const completion = await openaiChatDetailed(openaiKey, 'gpt-4.1', [{ role: 'system', content: system }, { role: 'user', content: user }]);
        const generated = parseJson(completion.content);
        if (generated.decision !== 'draft') {
          return res.status(422).json({
            error: String(generated.review_note || 'The approved correction is not directly supported by the retrieved FAQ and Notice evidence. Review the dispute wording or source coverage before generating a snippet.'),
            needsReview: true
          });
        }
        if (!generated.title || !generated.trigger_terms || !generated.instruction) {
          throw new Error('The generated snippet was incomplete. Please try again.');
        }
        const { data: updated, error: updateError } = await sb.from('disputes').update({
          status: 'approved',
          generated_title: String(generated.title).trim(),
          generated_trigger_terms: String(generated.trigger_terms).trim(),
          generated_snippet: String(generated.instruction).trim(),
          generated_at: new Date().toISOString(),
          sources: [...(Array.isArray(dispute.sources) ? dispute.sources.filter((item) => item?.type !== 'correction_evidence') : []), ...correctionEvidence]
        }).eq('id', id).select().single();
        if (updateError) throw updateError;
        await logActivity({actorRole:access.role,userEmail:access.email,userName:access.name,sessionId:access.sessionId,eventType:'snippet_regeneration',success:true,metadata:{disputeId:id,snippetId:linkedSnippet?.id || null,faqEvidenceCount:scopedEvidence.length,noticeEvidenceCount:noticeEvidence.length,activeSnippetPreserved:!!linkedSnippet}});
        return res.status(200).json({ dispute: { ...updated, linked_snippet: linkedSnippet }, draft: true, replacement: !!linkedSnippet });
      }

      if (action === 'activate-snippet') {
        if (dispute.status !== 'approved' || !dispute.generated_snippet) return res.status(400).json({ error: 'Generate and review a correction draft first.' });
        const title = String(req.body?.title || dispute.generated_title || '').trim();
        const triggerTerms = String(req.body?.triggerTerms || dispute.generated_trigger_terms || '').trim();
        const instruction = String(req.body?.instruction || dispute.generated_snippet || '').trim();
        if (title.length < 4 || triggerTerms.length < 3 || instruction.length < 20) return res.status(400).json({ error: 'Complete the title, trigger terms, and reviewed instruction before activation.' });
        const { data: existing, error: existingError } = await sb.from('ai_snippets').select('*').eq('source_dispute_id', dispute.id);
        if (existingError) throw existingError;
        const current = (existing || [])[0] || null;
        const snippetWrite = current
          ? sb.from('ai_snippets').update({ title, trigger_terms: triggerTerms, instruction, active: true }).eq('id', current.id).select().single()
          : sb.from('ai_snippets').insert({ title, trigger_terms: triggerTerms, instruction, source_dispute_id: dispute.id, active: true }).select().single();
        const { data: snippet, error: snippetError } = await snippetWrite;
        if (snippetError) throw snippetError;
        const { data: updated, error: updateError } = await sb.from('disputes').update({ status: 'snippet_generated', generated_title: title, generated_trigger_terms: triggerTerms, generated_snippet: instruction, generated_at: new Date().toISOString() }).eq('id', id).select().single();
        if (updateError) throw updateError;
        await logActivity({actorRole:access.role,userEmail:access.email,userName:access.name,sessionId:access.sessionId,eventType:'dispute_review',success:true,metadata:{disputeId:id,status:'snippet_generated',snippetId:snippet.id,replacedExisting:!!current,reason:current ? 'Admin reviewed and explicitly activated regenerated correction' : 'Admin reviewed and explicitly activated correction'}});
        return res.status(200).json({ dispute: updated, snippet });
      }

      return res.status(400).json({ error: 'Unknown dispute action.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
