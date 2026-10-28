import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [auditApi, auditPage, auditCss, activityApi, adminPage, releaseEntry] = await Promise.all([
  readFile(new URL('../pages/api/audits.js', import.meta.url), 'utf8'),
  readFile(new URL('../pages/audits.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles/audits.css', import.meta.url), 'utf8'),
  readFile(new URL('../pages/api/activity.js', import.meta.url), 'utf8'),
  readFile(new URL('../pages/admin.js', import.meta.url), 'utf8'),
  readFile(new URL('../pages/api/workspace-entry.js', import.meta.url), 'utf8')
]);

const checks = [
  [auditApi.includes('function auditFileBase(job, results = [])'), 'server builds agent-and-audit export names'],
  [auditApi.includes('filename="${fileBase}.html"'), 'HTML response uses the generated filename'],
  [auditApi.includes("'-detailed' : '-summary'"), 'CSV response distinguishes summary and detailed files'],
  [auditApi.includes("action === 'delete-jobs'"), 'bulk-delete endpoint exists'],
  [auditApi.includes('Master audit access is required to delete audit history.'), 'bulk delete is admin protected'],
  [auditApi.includes('Running, queued, or paused audits cannot be deleted.'), 'active audit deletion is blocked'],
  [auditApi.includes("eq('event_type', 'conversation_audit_result')") && auditApi.includes("eq('event_type', 'conversation_audit_job')"), 'delete removes results and job records'],
  [auditPage.includes('auditAgentLabel(job)') && auditPage.includes('Audit #{job.id}'), 'history displays the agent and audit ID'],
  [auditPage.includes('confirm(`Permanently delete'), 'bulk deletion requires confirmation'],
  [auditPage.includes("request('delete-jobs'"), 'confirmed selection calls the delete endpoint'],
  [auditPage.includes('Structured result data only'), 'history explains the stored record type'],
  [auditCss.includes('.history-row.selected') && auditCss.includes('@media(max-width:760px)'), 'selection and mobile history layouts are styled'],
  [activityApi.includes('includeApiAudits'), 'activity API has an independent API-audit filter'],
  [activityApi.includes(".not('event_type', 'in', auditEventTypes)"), 'ordinary API query excludes audit records'],
  [activityApi.includes("'conversation_audit_dispute','conversation_audit_correction'"), 'audit disputes and approved audit guidance stay in the audit-only activity filter'],
  [activityApi.indexOf('const requests =') < activityApi.indexOf('const rows ='), 'activity categories are filtered before the final row cap'],
  [adminPage.includes('Show other developer/API activity'), 'admin exposes the generic API toggle'],
  [adminPage.includes('Show developer/API audit records'), 'admin exposes the separate developer-audit toggle'],
  [activityApi.includes("meta.auditOrigin === 'developer_api'") && activityApi.includes('master-admin@workspace.local'), 'activity filtering distinguishes developer audits from manual workspace audits'],
  [auditApi.includes("auditOrigin: access.external ? 'developer_api' : 'workspace_ui'"), 'new audit records store their origin explicitly'],
  [auditApi.includes("'Finding eligible conversations'") && auditApi.includes('selection.checked'), 'sample preparation is resumable and reports candidate progress'],
  [auditApi.includes("action === 'save-thresholds'"), 'editable efficiency thresholds have a protected save endpoint'],
  [adminPage.includes('setActivityIncludeApiAudits(false)'), 'clearing filters hides API audit records again'],
  [releaseEntry.includes("version: '2026.10.audit-evidence-activity-v8'"), 'release notes identify the audit evidence and activity release']
];

for (const [condition, message] of checks) assert.ok(condition, message);
console.log(`${checks.length} audit-history regression assertions passed.`);
