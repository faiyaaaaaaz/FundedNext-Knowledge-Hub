import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scoreEfficiency, humanEfficiencyComment, humanEfficiencyStory } from '../lib/auditFeedback.mjs';

const auditSource = await readFile(new URL('../lib/audits.js', import.meta.url), 'utf8');
const auditPage = await readFile(new URL('../pages/audits.js', import.meta.url), 'utf8');
const auditApi = await readFile(new URL('../pages/api/audits.js', import.meta.url), 'utf8');
const appShell = await readFile(new URL('../pages/_app.js', import.meta.url), 'utf8');
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
check(/targets\.map\(\(target\)/.test(auditPage), 'one button is rendered for each measurement that cost marks');

// Speed and token economy: one model call per audit, compact numbered transcript, shared reads.
check(!/REPAIR REQUIRED/.test(auditSource), 'there is no second full-context model call per audit');
check((auditSource.match(/openaiChatDetailed\(item\.key/g) || []).length === 1, 'exactly one Gemini request is built per attempt');
check(/function auditPromptTranscript/.test(auditSource) && /function auditPromptMetrics/.test(auditSource), 'transcript and measurements are compacted before the model sees them');
check(/MEASUREMENTS: \$\{JSON\.stringify\(auditPromptMetrics\(metrics\)\)\}/.test(auditSource), 'the full measurement ledger is not sent to the model');
check(/\$\{scoringMatrix\}\\n\\nTARGET AGENT/.test(auditSource), 'the unchanging matrix leads the prompt so the shared prefix can be reused');
check(!/"recommendedResponse":""|"strengths":\[\]|"evidenceUsed":\[1\]/.test(auditSource), 'fields nothing displays or exports are no longer requested');
check(/loadEvidenceTables/.test(auditSource) && /let ADMINS_CACHE/.test(auditSource), 'notices, corrections and the admin list are read once per batch, not once per conversation');
check(/AUDIT_RUBRIC_VERSION = 'fn-cx-qa-2026\.11\.04-q4-v11'/.test(auditSource), 'the rubric version changed so old cached results are not reused');

// Evidence: every deduction cites a numbered message, with fallbacks that never leave a silent gap.
check(/evidenceRef/.test(auditSource) && /locateByReason/.test(auditSource) && /bestSentenceIn/.test(auditSource), 'deductions resolve through a message number, then the quote, then the reason');
check(/View most likely message/.test(auditPage), 'an approximate match is labelled as the most likely message, not as evidence');

// Speed summaries, redaction safety and the refreshed interface.
check(/function conversationTiming/.test(auditPage) && /function summarizeTiming/.test(auditPage) && /function TimingChips/.test(auditPage), 'every conversation shows FRT, average ART and AHT');
check(/batchTiming/.test(auditPage) && /className="speed-summary"/.test(auditPage), 'each batch shows its average FRT, ART and AHT');
check(/history-timing/.test(auditPage) && /timingSummary/.test(auditPage), 'history rows show the batch timing averages');
check(/function summarizeTiming/.test(auditApi) && /timingSummary: enrichment\.timingSummary/.test(auditApi), 'the server supplies timing averages for saved batches');
check(/const redactBody = /.test(auditSource), 'each message is redacted on its own so timestamps cannot be overwritten');
check(!/\\\[\?AGENT\(\?:\[_ \]\\d\+\)\?\\\]\?/.test(auditSource), 'the plain word "agent" is never rewritten as a token');
check(/refresh\.css/.test(appShell), 'the refreshed stylesheet is loaded last');
check(/function DeductionItem/.test(auditPage) && /levelParts/.test(auditPage) && /level-facts/.test(auditPage), 'score-level explanations are shown as plain labelled facts');
check(/<details className="aht-verification">/.test(auditPage), 'timing details are collapsed by default');


// Wording: sentences are rounded like a person would say them; exact figures sit in a separate list.
const sample = { frtSeconds: 52, frtHit: false, frtTarget: 30, responseTimes: [40, 140, 95], artBreaches: 2, artTarget: 90, ahtSeconds: 1290, ahtTarget: 1200, ahtHit: false };
const story = humanEfficiencyStory(sample);
check(!/\d+\s*(?:seconds?|secs?)\b/i.test(story.summary + story.advice), 'sentences never quote exact seconds');
check(story.numbers.length === 3 && story.numbers.some((entry) => /FRT 52s/.test(entry)) && story.numbers.some((entry) => /AHT 21m 30s/.test(entry)), 'exact FRT, ART and AHT are listed separately');
check(/\n\nNumbers: FRT 52s/.test(humanEfficiencyComment(sample)), 'the comment ends with a separate Numbers line');
check(!/approved Level|matrix/i.test(story.summary), 'the reason does not quote the internal matrix');
check(humanEfficiencyStory({ supportLevel: 'level2', ahtSeconds: 410, ahtTarget: 300, ahtHit: false }).numbers.length === 1, 'Level 2 lists only AHT');

// Focused audits: every human who really helped is scored on their own part; Level 2 uses the Level 2 rules.
check(/function auditTargetIds/.test(auditApi) && (auditApi.match(/const targetIds = auditTargetIds\(item, meaningful\)/g) || []).length === 2, 'pasted conversation IDs score every participating agent, in both the ledger and the scoring step');
check(!/primaryMeaningfulAgentId/.test(auditApi), 'a pasted conversation is no longer reduced to one agent');
check(/supportLevel: level2AgentIds\.includes\(String\(targetId\)\) \? 'level2' : 'standard'/.test(auditApi), 'each agent is measured at their own saved support level');
check(/never deduct from the target for them/.test(auditSource) && /Level 2 target is judged/.test(auditSource), 'the rubric keeps other agents\' work out of the target\'s score');

// Access: only the Master Admin and Faiyaz see who runs audits or can grant access.
check(/function hideJobCreator/.test(auditApi) && /!canManageAudits\(access\)\) \{ const sendJson/.test(auditApi), 'job creators are hidden from everyone but the Master Admin and Faiyaz');
check(/action === 'save-access'\) \{\s*if \(!canManageAudits\(access\)\)/.test(auditApi) && /action === 'save-self-access'\) \{\s*if \(!canManageAudits\(access\)\)/.test(auditApi), 'only they can change audit access');
check(/config: !access\.external && canManageAudits\(access\) \? await getAuditAccessConfig/.test(auditApi), 'the authorized-auditor list is only sent to them');

console.log(`audit efficiency regression: ${count} assertions passed`);
