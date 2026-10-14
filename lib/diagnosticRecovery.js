import crypto from 'crypto';
import { gunzipSync } from 'zlib';

export const MAX_UPLOAD_BYTES = 3.5 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const bad = (message) => { const error = new Error(message); error.status = 400; throw error; };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const text = (value, label, optional = true) => {
  if (value == null && optional) return '';
  if (typeof value !== 'string') bad(`${label} must be text.`);
  return value;
};
const numericId = (value, label) => {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 1 || !/^\d+$/.test(String(value))) bad(`${label} must be a positive integer.`);
  return Number(value);
};
const date = (value, label, optional = false) => {
  if (!value && optional) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) bad(`${label} must be a valid timestamp.`);
  return value;
};
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
function list(value, label, limit) {
  if (!Array.isArray(value) || value.length > limit) bad(`${label} must be an array with no more than ${limit} records.`);
  return value;
}
function unique(rows, key, label) {
  const seen = new Set();
  for (const row of rows) {
    if (!object(row)) bad(`${label} contains an invalid record.`);
    const id = String(row[key]);
    if (seen.has(id)) bad(`${label} contains duplicate identifier ${id}.`);
    seen.add(id);
  }
}

// Only mapped data reaches the database. Uploaded text is never executed,
// interpreted as instructions, or used to write settings/API keys/Notices.
export function decodeRecoveryUpload(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) bad('Choose a diagnostic .json.gz file.');
  if (buffer.length > MAX_UPLOAD_BYTES) { const error = new Error('The upload is too large. Use a .json.gz report below 3.5 MB.'); error.status = 413; throw error; }
  let expanded;
  try {
    expanded = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer, { maxOutputLength: MAX_EXPANDED_BYTES }) : buffer;
  } catch { bad('This gzip file is damaged or expands beyond the 32 MB safety limit.'); }
  if (expanded.length > MAX_EXPANDED_BYTES) bad('The report expands beyond the 32 MB safety limit.');
  let report;
  try { report = JSON.parse(expanded.toString('utf8')); } catch { bad('The uploaded file does not contain valid JSON.'); }
  if (!object(report) || report.schema !== 'fundednext-admin-diagnostics' || report.version !== 1) bad('Use a combined FundedNext admin diagnostics report (version 1).');
  if (!object(report.queryReview) || report.queryReview.schema !== 'fundednext-evaluation-report' || report.queryReview.version !== 4) bad('This query report version is unsupported. No records have been changed.');
  const queries = list(report.queryReview.queries, 'Queries', 20000);
  const disputes = list(report.queryReview.approvedDisputes, 'Approved disputes', 5000);
  if (!object(report.snippetUsage)) bad('The snippet usage section is missing.');
  const events = list(report.snippetUsage.events, 'Snippet-use events', 20000);
  unique(queries, 'id', 'Queries'); unique(disputes, 'id', 'Disputes'); unique(events, 'id', 'Snippet-use events');
  const exportedAt = date(report.exportedAt, 'Export date');
  const reportHash = hash(expanded);
  const recovery = (kind, sourceId) => ({ version: 1, reportHash, exportedAt, kind, sourceId: String(sourceId), importedFromDiagnostic: true });
  const eventGroups = new Map();
  const versions = new Map();
  const mappedEvents = events.map((event) => {
    const id = text(event.id, 'Snippet-use ID', false);
    if (!id || id.length > 200) bad('A snippet-use ID is missing or too long.');
    const snippetId = event.snippetId == null ? null : numericId(event.snippetId, 'Snippet ID');
    const queryLogId = event.queryLogId == null ? null : numericId(event.queryLogId, 'Query reference');
    const instruction = text(event.instruction, 'Snippet instruction');
    const triggerTerms = text(event.triggerTerms, 'Snippet triggers');
    const title = text(event.title, 'Snippet title');
    date(event.createdAt, 'Snippet-use date');
    const instructionHash = instruction ? hash(instruction) : text(event.instructionHash, 'Instruction hash');
    if (instruction && event.instructionHash && event.instructionHash !== instructionHash) bad(`Snippet-use ${id} has an instruction hash mismatch.`);
    const use = { snippetId, title, triggerTerms, instruction, instructionHash, matchScore: number(event.matchScore), injection: text(event.injection, 'Injection'), influence: text(event.influence, 'Influence') };
    if (queryLogId) { const group = eventGroups.get(String(queryLogId)) || []; group.push(use); eventGroups.set(String(queryLogId), group); }
    if (snippetId && instruction && triggerTerms && title) {
      const group = versions.get(String(snippetId)) || [];
      group.push({ ...use, createdAt: event.createdAt, eventId: id }); versions.set(String(snippetId), group);
    }
    return { sourceId: id, queryLogId, snippetId, instructionHash, record: {
      event_type: 'snippet_usage', created_at: event.createdAt, user_name: text(event.userName, 'User name') || null,
      user_email: text(event.userEmail, 'User email') || null, session_id: text(event.sessionId, 'Session ID') || null, success: true,
      metadata: { ...event, ...use, queryLogId, recovery: recovery('snippet_usage', id) }
    } };
  });
  const availabilityCounts = { fullQuestions: 0, questionPreviews: 0, missingQuestions: 0, fullAnswers: 0, answerPreviews: 0, missingAnswers: 0 };
  const mappedQueries = queries.map((query) => {
    const id = numericId(query.id, 'Query ID');
    date(query.createdAt, 'Query date');
    const question = text(query.question, 'Question'); const answer = text(query.answer, 'Answer');
    const availability = object(query.availability) ? query.availability : {};
    const qState = availability.question || (query.questionTruncated ? 'preview_only' : question ? 'recorded' : 'not_recorded');
    // Exported "answer" can be an error/stage label, so availability is the
    // authority for whether it is really a stored answer.
    const aState = availability.answer || 'not_recorded';
    for (const state of [qState, aState]) if (!['recorded', 'preview_only', 'not_recorded'].includes(state)) bad('Unknown question/answer availability state.');
    availabilityCounts[qState === 'recorded' ? 'fullQuestions' : qState === 'preview_only' ? 'questionPreviews' : 'missingQuestions']++;
    availabilityCounts[aState === 'recorded' ? 'fullAnswers' : aState === 'preview_only' ? 'answerPreviews' : 'missingAnswers']++;
    const meta = {
      recovery: { ...recovery('query', id), availability, reportedAnswerDisplay: aState === 'not_recorded' ? answer : null },
      recoveredDiagnostic: query,
      questionTruncated: qState === 'preview_only' || !!query.questionTruncated,
      answerTruncated: aState === 'preview_only' || !!query.answerTruncated,
      selectedProduct: query.product || '', selectedModel: query.accountModel || '', selectedScopeLabel: query.scopeLabel || '',
      confidence: query.confidence ?? null, confidenceLabel: query.confidenceLabel || '', sourceCount: query.sourceCount || 0,
      sources: Array.isArray(query.sources) ? query.sources : [], feedback: query.feedback || '', feedbackAt: query.feedbackAt || '', feedbackBy: query.feedbackBy || '',
      durationMs: query.durationMs || 0, fallback: !!query.fallback, groqKeyLabel: query.groqKeyLabel || '',
      interpretation: query.interpretation || null, evidenceTrail: query.evidenceTrail || null, processing: query.processing || null,
      refusalReason: query.refusalReason || '', grounding: query.grounding ?? null,
      status: query.status || 'recovered_history', stage: query.stage || null, error: query.error || null, reason: query.reason || null,
      questionCoverage: query.questionCoverage || null, coverageSummary: query.coverageSummary || null, noticeConflict: query.noticeConflict || null,
      evidenceSnapshot: query.evidenceSnapshot || null, reviewTrace: query.reviewTrace || null,
      recoveredSnippetUses: eventGroups.get(String(id)) || [], answerWordCount: query.answerWordCount || 0
    };
    if (qState === 'recorded' && question) meta.question = question;
    if (qState === 'preview_only' && question) meta.questionPreview = question;
    if (aState === 'recorded' && answer) meta.answer = answer;
    if (aState === 'preview_only' && answer) meta.answerPreview = answer;
    return { sourceId: String(id), record: {
      id, created_at: query.createdAt, event_type: 'query', actor_role: text(query.actorRole, 'Actor role') || null,
      user_name: text(query.userName, 'User name') || null, user_email: text(query.userEmail, 'User email') || null,
      provider: text(query.provider, 'Provider') || null, model: text(query.model, 'Model') || null,
      question_word_count: number(query.questionWordCount), input_tokens: number(query.inputTokens), output_tokens: number(query.outputTokens),
      estimated_cost: number(query.estimatedCost), success: query.storedSuccessFlag !== false, metadata: meta
    } };
  });
  const mappedDisputes = disputes.map((dispute) => {
    const id = numericId(dispute.id, 'Dispute ID');
    if (!['approved', 'snippet_generated'].includes(dispute.status)) bad('Only approved disputes may be recovered.');
    date(dispute.created_at, 'Dispute date');
    const record = {};
    for (const key of ['id', 'status', 'question', 'answer', 'dispute_reason', 'approval_reason', 'reviewed_at', 'created_at', 'user_name', 'user_email', 'provider', 'confidence', 'sources', 'generated_title', 'generated_snippet', 'generated_at']) if (dispute[key] !== undefined) record[key] = dispute[key];
    for (const key of ['question', 'answer', 'dispute_reason', 'approval_reason', 'generated_title', 'generated_snippet']) text(record[key], `Dispute ${key}`);
    date(record.reviewed_at, 'Review date', true); date(record.generated_at, 'Generated date', true);
    record.id = id;
    return { sourceId: String(id), record };
  });
  let ambiguousSnippets = 0;
  const mappedSnippets = [...versions.entries()].flatMap(([id, group]) => {
    group.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const latest = group[0];
    const sameTime = group.filter(item => Date.parse(item.createdAt) === Date.parse(latest.createdAt));
    if (new Set(sameTime.map(item => JSON.stringify([item.instruction, item.triggerTerms, item.title]))).size > 1) { ambiguousSnippets++; return []; }
    const matches = disputes.filter(item => item.generated_snippet === latest.instruction);
    const sourceDisputeId = matches.length === 1 ? Number(matches[0].id) : null;
    // Keep all historical versions in the import audit record. The live
    // library receives only the newest observed version, initially inactive.
    return [{ sourceId: id, sourceDisputeId, versions: group, record: {
      id: Number(id), title: latest.title, trigger_terms: latest.triggerTerms, instruction: latest.instruction,
      source_dispute_id: sourceDisputeId, active: false, created_at: group[group.length - 1].createdAt, updated_at: latest.createdAt
    } }];
  });
  return {
    reportHash, exportedAt,
    queries: mappedQueries, disputes: mappedDisputes, snippets: mappedSnippets, events: mappedEvents,
    summary: { queries: queries.length, disputes: disputes.length, snippetCandidates: mappedSnippets.length, snippetUses: events.length,
      noticesExcluded: Array.isArray(report.noticeKnowledge?.records) ? report.noticeKnowledge.records.length : 0,
      ambiguousSnippets, ...availabilityCounts },
    policy: 'Insert missing history only; preserve existing rows; recovered snippets start inactive; Notices are excluded.'
  };
}
