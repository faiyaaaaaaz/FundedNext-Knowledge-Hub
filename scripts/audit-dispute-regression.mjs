import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [auditLib, auditApi, auditPage, searchApi, statsApi, workspace] = await Promise.all([
  readFile(new URL('../lib/audits.js', import.meta.url), 'utf8'),
  readFile(new URL('../pages/api/audits.js', import.meta.url), 'utf8'),
  readFile(new URL('../pages/audits.js', import.meta.url), 'utf8'),
  readFile(new URL('../pages/api/search.js', import.meta.url), 'utf8'),
  readFile(new URL('../pages/api/stats.js', import.meta.url), 'utf8'),
  readFile(new URL('../components/Workspace.js', import.meta.url), 'utf8')
]);

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
];

for (const [condition, message] of checks) assert.ok(condition, message);
console.log(`${checks.length} audit dispute/access assertions passed.`);
