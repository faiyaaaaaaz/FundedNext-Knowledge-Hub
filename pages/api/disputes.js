import {
  authenticateRequest, supabaseAdmin, getKeys, openaiEmbed,
  openaiChatDetailed, getBrandingRules, brandingInstructions, logActivity
} from '../../lib/server';

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
        sources: Array.isArray(body.sources) ? body.sources : []
      }).select().single();
      if (error) throw error;
      await logActivity({
        actorRole: access.role, sessionId: access.sessionId,
        userName: access.name, userEmail: access.email, authProvider: access.authProvider,
        eventType: 'dispute',
        provider: body.provider, metadata: { disputeId: data.id, questionPreview: String(body.question).slice(0, 180) }
      });
      return res.status(200).json({ dispute: data });
    }

    if (access.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });

    if (req.method === 'GET') {
      let query = sb.from('disputes').select('*').order('created_at', { ascending: false }).limit(300);
      if (req.query.status) query = query.eq('status', req.query.status);
      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json({ disputes: data || [] });
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
        return res.status(200).json({ dispute: data });
      }

      if (action === 'generate') {
        if (dispute.status !== 'approved') return res.status(400).json({ error: 'Approve the dispute before generating a snippet.' });
        const { openaiKey, groqKey, chatModel, chatProvider } = await getKeys();
        if (!openaiKey) throw new Error('OpenAI key is required to verify the FAQ.');
        const [vector] = await openaiEmbed(openaiKey, [dispute.question]);
        const result = await sb.rpc('match_chunks', { query_embedding: vector, match_threshold: 0.12, match_count: 12 });
        if (result.error) throw result.error;
        const evidence = (result.data || []).map((item, index) =>
          `[${index + 1}] ${item.article_title}\n${item.content}`
        ).join('\n\n---\n\n');
        const rules = await getBrandingRules();
        const system =
          'You are creating a permanent corrective instruction for a support-answering AI. ' +
          'Re-check the FAQ evidence. Do not accept the original answer or dispute as truth without evidence. ' +
          'Return strict JSON only with keys title, trigger_terms, instruction. ' +
          'trigger_terms must be a comma-separated list. instruction must be concise, unambiguous, product-scoped, ' +
          'and state what the AI must and must not do in future answers.' + brandingInstructions(rules);
        const user =
          `Original question:\n${dispute.question}\n\nDisputed answer:\n${dispute.answer}\n\n` +
          `Agent dispute reason:\n${dispute.dispute_reason}\n\nAdmin approval reason:\n${dispute.approval_reason}\n\n` +
          `Fresh FAQ evidence:\n${evidence || 'No matching FAQ evidence was found.'}`;
        let completion;
        if (chatProvider === 'groq' && groqKey) {
          try {
            completion = await openaiChatDetailed(groqKey, chatModel, [{ role: 'system', content: system }, { role: 'user', content: user }], 'https://api.groq.com/openai/v1');
          } catch {
            completion = await openaiChatDetailed(openaiKey, 'gpt-4.1', [{ role: 'system', content: system }, { role: 'user', content: user }]);
          }
        } else {
          completion = await openaiChatDetailed(openaiKey, chatModel, [{ role: 'system', content: system }, { role: 'user', content: user }]);
        }
        const generated = parseJson(completion.content);
        if (!generated.title || !generated.trigger_terms || !generated.instruction) {
          throw new Error('The generated snippet was incomplete. Please try again.');
        }
        const { data: snippet, error: snippetError } = await sb.from('ai_snippets').insert({
          title: String(generated.title).trim(),
          trigger_terms: String(generated.trigger_terms).trim(),
          instruction: String(generated.instruction).trim(),
          source_dispute_id: dispute.id,
          active: true
        }).select().single();
        if (snippetError) throw snippetError;
        const { data: updated, error: updateError } = await sb.from('disputes').update({
          status: 'snippet_generated',
          generated_title: snippet.title,
          generated_trigger_terms: snippet.trigger_terms,
          generated_snippet: snippet.instruction,
          generated_at: new Date().toISOString()
        }).eq('id', id).select().single();
        if (updateError) throw updateError;
        return res.status(200).json({ dispute: updated, snippet });
      }

      return res.status(400).json({ error: 'Unknown dispute action.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
