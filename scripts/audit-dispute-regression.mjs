import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [auditLib, auditApi, auditPage, searchApi, statsApi, workspace, adminPage] = await Promise.all([
  readFile(new URL('../lib/audits.js', import.meta.url), 'utf8'),
  readFile(new URL('../pages/api/audits.js', import.meta.url), 'utf8'),
  readFile(new URL('../pages/audits.js', import.meta.url), 'utf8'),
  readFile(new URL('../pages/api/search.js', import.meta.url), 'utf8'),
  readFile(new URL('../pages/api/stats.js', import.meta.url), 'utf8'),
  readFile(new URL('../components/Workspace.js', import.meta.url), 'utf8'),
  readFile(new URL('../pages/admin.js', import.meta.url), 'utf8')
]);
const answerDisputeApi = await readFile(new URL('../pages/api/disputes.js', import.meta.url), 'utf8');

const checks = [
  [auditLib.includes("const SETTING_SELF_ACCESS = 'audit_self_access_emails'"), 'self-only audit access has an independent setting'],
  [auditLib.includes("return 'auditor'") && auditLib.includes("return 'self'"), 'audit permissions distinguish leads from agents'],
  [auditApi.includes("action === 'submit-dispute'") && auditApi.includes("action === 'review-dispute'"), 'submit and review dispute endpoints exist'],
  [auditApi.includes("event_type: 'conversation_audit_correction'"), 'approved disputes create audit-only guidance'],
  [auditLib.includes("eq('event_type', 'conversation_audit_correction')"), 'audit retrieval reads approved audit guidance'],
  [!searchApi.includes("conversation_audit_correction"), 'customer chatbot never reads audit guidance'],
  [auditApi.includes('You can dispute only your own audit results.'), 'self-only users cannot dispute another agent result'],
  [auditApi.includes('You can open transcripts only for your own audit results.'), 'self-only transcript access is enforced by the API'],
  [auditApi.includes('permission === \'self\' ? [] : admins'), 'agent bootstrap does not reveal the Intercom directory'],
  [auditPage.includes('Approve &amp; save audit guidance') && auditPage.includes('Dispute this audit'), 'audit modal exposes both sides of the workflow'],
  [auditPage.includes('loading="lazy"') && auditPage.includes('transcript-attachments'), 'transcript images load lazily on demand'],
  [statsApi.includes("auditAccess") && workspace.includes('◎ My Audits'), 'workspace exposes My Audits only to authorized users'],
  [searchApi.includes('NOTICE[\\s_-]*CONFLICT'), 'private response metadata accepts underscore-free labels'],
  [auditPage.includes('history-scores') && auditApi.includes('scoreSummary'), 'history shows color-ready score summaries']
  ,[auditLib.includes('preya@nextventures.io') && auditLib.includes('canReviewAuditDisputes'), 'audit dispute decisions are restricted to the named reviewers']
  ,[auditApi.includes("action === 'update-audit-snippet'") && auditApi.includes("action === 'delete-audit-snippet'"), 'audit snippets can be edited and deleted through restricted endpoints']
  ,[auditApi.includes('evidenceCheckedAt') && auditApi.includes("['FAQ','Notice'].includes(item.kind)"), 'approval performs a fresh FAQ and Notice evidence check']
  ,[auditPage.includes("setView('disputes')") && auditPage.includes("setView('snippets')"), 'auditor admin exposes separate dispute and snippet sections']
  ,[auditLib.includes('row.metadata?.active !== false'), 'inactive audit guidance is excluded from future audits']
  ,[answerDisputeApi.includes('EXACT FAQ REQUESTED BY REVIEWER') && answerDisputeApi.includes('loadReferencedFaqEvidence'), 'answer disputes load a reviewer-cited FAQ URL before drafting a correction']
  ,[answerDisputeApi.includes('explicitFaqLoadedCount'), 'snippet diagnostics record whether cited FAQs were actually loaded']
  ,[answerDisputeApi.includes("action === 'reopen'") && answerDisputeApi.includes('Approved dispute returned to review'), 'an incorrect approval can be returned to review before snippet activation']
  ,[adminPage.includes('Return to review'), 'the dispute admin exposes the approval recovery action']
];

for (const [condition, message] of checks) assert.ok(condition, message);
console.log(`${checks.length} audit dispute/access assertions passed.`);
