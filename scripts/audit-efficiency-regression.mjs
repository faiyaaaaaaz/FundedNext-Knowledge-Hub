import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scoreEfficiency, humanEfficiencyComment } from '../lib/auditFeedback.mjs';

const auditSource = await readFile(new URL('../lib/audits.js', import.meta.url), 'utf8');
const auditPage = await readFile(new URL('../pages/audits.js', import.meta.url), 'utf8');
let count = 0;
const check = (condition, message) => { assert.ok(condition, message); count += 1; };

// A measurement that could not be taken is never the agent's fault.
check(scoreEfficiency({ frtSeconds: 18, frtHit: true, responseTimes: [17, 26, 33], artBreaches: 0, ahtSeconds: null, slaStatus: 'hit' }) === 10, 'unmeasurable AHT with FRT and ART met is not penalised');
check(scoreEfficiency({ frtSeconds: null, ahtSeconds: null, slaStatus: 'unknown', responseTimes: [] }) === 10, 'nothing measurable means no deduction');
check(scoreEfficiency({ supportLevel: 'level2', ahtSeconds: null }) === 10, 'Level 2 with unmeasurable AHT is not penalised');
check(/no marks were deducted/i.test(humanEfficiencyComment({ ahtSeconds: null, frtSeconds: 18, frtHit: true, responseTimes: [17] })), 'comment says nothing was deducted for unmeasurable AHT');

// Real misses still cost marks exactly as the approved matrix says.
check(scoreEfficiency({ frtSeconds: 100, frtHit: false, responseTimes: [], ahtSeconds: 300, ahtTarget: 1200 }) === 5, 'FRT miss alone is 5');
check(scoreEfficiency({ frtSeconds: 10, frtHit: true, responseTimes: [200, 300], ahtSeconds: 300 }) === 3, 'two ART misses is 3');
check(scoreEfficiency({ frtSeconds: 10, frtHit: true, responseTimes: [10], ahtSeconds: 1600, ahtTarget: 1200 }) === 4, 'AHT far over target is 4');
check(scoreEfficiency({ frtSeconds: 10, frtHit: true, responseTimes: [10], ahtSeconds: 300, ahtTarget: 1200 }) === 10, 'everything within target is 10');
check(scoreEfficiency({ selfAssigned: true, frtSeconds: 1, frtHit: true, ahtSeconds: 60 }) === 0, 'self-assignment is still 0');

// Ownership windows: a bounced assignment or a transfer must not hide the agent's real work.
check(/stuckAssignment/.test(auditSource) && /firstTargetReply\?\.at/.test(auditSource), 'assignment bounces before the first reply do not end the window');
check(/isTransferOut/.test(auditSource) && /endType: 'transfer'/.test(auditSource), 'a transfer ends the handling episode');

// Evidence buttons: every Efficiency deduction opens the exact marker it came from.
check(/function efficiencyEvidenceTargets/.test(auditPage) && /metric-aht-unavailable/.test(auditPage), 'Efficiency deductions open their timing markers, including unavailable measurements');
check(/evidenceTargets\.map/.test(auditPage), 'one button is rendered for each measurement that cost marks');

// Speed and token economy: one model call per audit, compact numbered transcript, shared reads.
check(!/REPAIR REQUIRED/.test(auditSource), 'there is no second full-context model call per audit');
check((auditSource.match(/openaiChatDetailed\(item\.key/g) || []).length === 1, 'exactly one Gemini request is built per attempt');
check(/function auditPromptTranscript/.test(auditSource) && /function auditPromptMetrics/.test(auditSource), 'transcript and measurements are compacted before the model sees them');
check(/MEASUREMENTS: \$\{JSON\.stringify\(auditPromptMetrics\(metrics\)\)\}/.test(auditSource), 'the full measurement ledger is not sent to the model');
check(/\$\{scoringMatrix\}\\n\\nTARGET AGENT/.test(auditSource), 'the unchanging matrix leads the prompt so the shared prefix can be reused');
check(!/"recommendedResponse":""|"strengths":\[\]|"evidenceUsed":\[1\]/.test(auditSource), 'fields nothing displays or exports are no longer requested');
check(/loadEvidenceTables/.test(auditSource) && /let ADMINS_CACHE/.test(auditSource), 'notices, corrections and the admin list are read once per batch, not once per conversation');
check(/AUDIT_RUBRIC_VERSION = 'fn-cx-qa-2026\.11\.03-q4-v10'/.test(auditSource), 'the rubric version changed so old cached results are not reused');

// Evidence: every deduction cites a numbered message, with fallbacks that never leave a silent gap.
check(/evidenceRef/.test(auditSource) && /locateByReason/.test(auditSource) && /bestSentenceIn/.test(auditSource), 'deductions resolve through a message number, then the quote, then the reason');
check(/View most likely message/.test(auditPage), 'an approximate match is labelled as the most likely message, not as evidence');

console.log(`audit efficiency regression: ${count} assertions passed`);
