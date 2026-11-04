function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }

export function secondsLabel(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

export function minutesLabel(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(seconds / 60); const remainder = seconds % 60;
  if (!remainder) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${minutes} minute${minutes === 1 ? '' : 's'} ${remainder} second${remainder === 1 ? '' : 's'}`;
}

export function buildAgentWorkloadLedger(records = []) {
  const byAgent = new Map();
  for (const record of records) for (const cycle of record.cycles || []) {
    if (cycle.incomplete || !cycle.replyId || !Number(cycle.endAt || 0)) continue;
    const agentId = String(record.agentId || ''); if (!agentId) continue;
    if (!byAgent.has(agentId)) byAgent.set(agentId, []);
    byAgent.get(agentId).push({ ...cycle, agentId, conversationId: String(record.conversationId || ''), intercomLink: record.intercomLink || '' });
  }
  const anchors = {};
  for (const [agentId, cycles] of byAgent) {
    cycles.sort((a, b) => Number(a.replyAt) - Number(b.replyAt) || Number(a.endAt) - Number(b.endAt));
    let previous = null;
    for (const cycle of cycles) {
      const readyAt = Number(cycle.readyAt || cycle.startAt || 0); const precedingEndAt = Number(previous?.endAt || 0); const previousReplyAt = Number(previous?.replyAt || 0);
      const startAt = Math.max(readyAt, previousReplyAt); const key = `${cycle.conversationId}:${agentId}:${cycle.replyId}`;
      anchors[key] = { startAt, readyAt, basis: previousReplyAt > readyAt ? 'resumed_after_previous_reply' : cycle.basis || 'episode_ready', previousReplyAt: previous?.replyAt || null, previousConversationId: previous?.conversationId || null, previousConversationLink: previous?.intercomLink || '', previousHandlingEndAt: previous?.endAt || null };
      previous = cycle;
    }
  }
  return anchors;
}

export function scoreEfficiency(metrics, defaults = { frtSeconds: 30, artSeconds: 90, ahtSeconds: 1200 }) {
  const frtTarget = Number(metrics.frtTarget || defaults.frtSeconds);
  const artTarget = Number(metrics.artTarget || defaults.artSeconds);
  const ahtTarget = Number(metrics.ahtTarget || defaults.ahtSeconds);
  // Self-assignment is a prohibited workflow action and overrides every timing
  // result for both standard and Level 2 support.
  if (metrics.selfAssigned) return 0;
  if (metrics.supportLevel === 'level2') {
    // A measurement that could not be taken is never the agent's fault: no marks are deducted.
    if (metrics.ahtSeconds == null) return 10;
    const aht = Number(metrics.ahtSeconds);
    if (aht < Math.max(0, ahtTarget - 60)) return 10;
    if (aht <= Math.max(0, ahtTarget - 30)) return 9;
    if (aht <= ahtTarget) return 8;
    if (aht <= ahtTarget + 180) return 7;
    if (aht <= ahtTarget + 300) return 6;
    if (aht <= ahtTarget + 420) return 5;
    if (aht <= ahtTarget + 480) return 4;
    if (aht <= ahtTarget + 600) return 3;
    return 2;
  }
  if (metrics.frtSeconds == null && metrics.ahtSeconds == null && metrics.slaStatus === 'unknown' && !metrics.responseTimes?.length) return 10;
  const frtMiss = metrics.frtHit === false;
  const artTimes = Array.isArray(metrics.responseTimes) ? metrics.responseTimes : [];
  const eligibleArt = artTimes.length;
  const metArt = artTimes.filter((seconds) => Number(seconds) <= artTarget).length;
  const artRate = eligibleArt ? metArt / eligibleArt : 1;
  const multipleArtMisses = Math.max(0, eligibleArt - metArt) >= 2;
  const aht = metrics.ahtSeconds == null ? null : Number(metrics.ahtSeconds);
  if (frtMiss && multipleArtMisses) return 2;
  if (!frtMiss && artRate < 0.8) return 3;
  // An AHT that could not be measured (aht == null) is skipped, never treated as a miss.
  if (frtMiss && ((aht != null && aht > ahtTarget + 180) || artRate < 0.8)) return 4;
  if (frtMiss || artRate < 0.8) return 5;
  if (aht != null && aht > ahtTarget + 300) return 4;
  if (aht != null && aht > ahtTarget + 180) return metrics.ahtDelayJustified ? 7 : 6;
  if (aht != null && aht > ahtTarget) return 8;
  if (artRate < 1) return 9;
  return (aht == null || aht < ahtTarget) && Number(metrics.frtSeconds) <= frtTarget ? 10 : 9;
}

// ---- human-readable Efficiency wording ---------------------------------------------------------
// Sentences speak the way a team lead would ("about a minute"); the exact figures are listed
// separately so they can still be checked.
export function roughSpan(value) {
  const s = Math.max(0, Math.round(Number(value) || 0));
  if (s < 15) return 'a few seconds';
  if (s < 40) return 'about half a minute';
  if (s < 55) return 'just under a minute';
  if (s < 75) return 'about a minute';
  if (s < 105) return 'about a minute and a half';
  if (s < 150) return 'about two minutes';
  if (s < 3300) { const m = Math.round(s / 60); return `about ${m} minutes`; }
  const h = Math.round(s / 360) / 10; return `about ${h === 1 ? 'an hour' : `${h} hours`}`;
}
export function shortTime(value) {
  const s = Math.max(0, Math.round(Number(value) || 0)); const m = Math.floor(s / 60); const r = s % 60;
  if (!m) return `${s}s`;
  return r ? `${m}m ${r}s` : `${m}m`;
}

export function efficiencyNumbers(metrics, defaults = { frtSeconds: 30, artSeconds: 90, ahtSeconds: 1200 }) {
  const out = [];
  const level2 = metrics.supportLevel === 'level2';
  if (!level2) {
    if (metrics.frtSeconds != null) out.push(`FRT ${shortTime(metrics.frtSeconds)} (target ${shortTime(metrics.frtTarget || defaults.frtSeconds)})`);
    const times = Array.isArray(metrics.responseTimes) ? metrics.responseTimes : [];
    if (times.length) {
      const slowest = Math.max(...times.map(Number));
      out.push(`ART ${metrics.artBreaches || 0} of ${times.length} ${times.length === 1 ? 'reply' : 'replies'} slower than ${shortTime(metrics.artTarget || defaults.artSeconds)} (slowest ${shortTime(slowest)})`);
    }
  }
  if (metrics.ahtSeconds != null) out.push(`AHT ${shortTime(metrics.ahtSeconds)} (target ${shortTime(metrics.ahtTarget || defaults.ahtSeconds)})`);
  return out;
}

function efficiencySentences(metrics, defaults) {
  const level2 = metrics.supportLevel === 'level2';
  const parts = [];
  if (!level2) {
    if (metrics.frtSeconds != null) {
      parts.push(metrics.frtHit === false ? `The first reply took ${roughSpan(metrics.frtSeconds)} after the chat reached the agent, which is slower than expected.` : 'The first reply came in on time.');
    }
    const times = Array.isArray(metrics.responseTimes) ? metrics.responseTimes : [];
    const late = Number(metrics.artBreaches || 0);
    if (times.length) {
      if (!late) parts.push('Follow-up replies stayed quick.');
      else if (late >= times.length && times.length > 1) parts.push('Almost every follow-up reply came later than it should have.');
      else if (late === 1) parts.push('One follow-up reply came later than it should have.');
      else parts.push(`${late} of the ${times.length} follow-up replies came later than they should have.`);
    }
  }
  if (metrics.ahtSeconds == null) {
    parts.push('How long the chat was held could not be measured, because nothing was snoozed, closed or transferred after the last reply, so no marks were deducted for it.');
  } else if (metrics.ahtHit === false) {
    parts.push(`The chat stayed with the agent for ${roughSpan(metrics.ahtSeconds)}, longer than the usual ${roughSpan(metrics.ahtTarget || defaults.ahtSeconds).replace(/^about /, '')}.`);
  } else {
    parts.push('The chat was handled and wrapped up within the expected time.');
  }
  return parts;
}

function efficiencyAdvice(metrics) {
  if (metrics.supportLevel === 'level2') return metrics.ahtHit === false ? 'Next time, prepare the full answer before sending and drop repeated explanations so the complete reply goes out sooner.' : 'Keep sending complete email-style replies without extra follow-up messages.';
  if (metrics.frtHit === false) return 'Next time, acknowledge the assignment straight away, then carry on investigating so the client knows it is being handled.';
  if (metrics.ahtHit === false) return 'Next time, put the diagnosis, the policy and the next step into one complete reply instead of repeating information.';
  if ((metrics.artBreaches || 0) > 0) return 'Next time, send a short progress update before the reply gap gets long while you are still investigating.';
  return 'Keep the same pace and keep each reply complete and clear.';
}

export function humanEfficiencyStory(metrics, defaults = { frtSeconds: 30, artSeconds: 90, ahtSeconds: 1200 }) {
  const numbers = efficiencyNumbers(metrics, defaults);
  if (metrics.selfAssigned) {
    return { summary: 'The agent assigned this conversation to themselves. Self-assignment is not allowed and automatically sets Efficiency to 0/10, whatever the speed was.', advice: 'Next time, leave the chat in the normal assignment queue and start only once it is assigned to you.', numbers };
  }
  const level2Note = metrics.supportLevel === 'level2' ? ['FRT and ART do not apply because this agent is on Level 2 email support.'] : [];
  return { summary: [...efficiencySentences(metrics, defaults), ...level2Note].join(' '), advice: efficiencyAdvice(metrics), numbers };
}

export function humanEfficiencyComment(metrics, defaults = { frtSeconds: 30, artSeconds: 90, ahtSeconds: 1200 }) {
  const story = humanEfficiencyStory(metrics, defaults);
  return `${story.summary} ${story.advice}${story.numbers.length ? `\n\nNumbers: ${story.numbers.join(' · ')}` : ''}`;
}

function reportFlags(audit) {
  const deductions = (audit?.deductions || []).filter((item) => item.transcriptExample).map((item) => ({ phrase: String(item.transcriptExample).trim(), category: item.category || 'quality', label: `${item.category || 'quality'} deduction` }));
  const accuracy = (audit?.accuracyIssues || []).filter((item) => item.wrongInformation).map((item) => ({ phrase: String(item.wrongInformation).trim(), category: 'accuracy', label: 'incorrect information' }));
  return [...deductions, ...accuracy].filter((item) => item.phrase.length >= 5);
}
function reportSpan(text, phrase) {
  const source = String(text || ''); const target = String(phrase || ''); const exact = source.toLowerCase().indexOf(target.toLowerCase());
  if (exact >= 0) return { start: exact, end: exact + target.length };
  const terms = target.toLowerCase().match(/[a-z0-9]{4,}/g) || []; if (terms.length < 2) return null;
  let cursor = 0; let best = null;
  for (const segment of source.split(/(?<=[.!?])\s+|\n+/)) {
    const start = source.indexOf(segment, cursor); cursor = Math.max(cursor, start + segment.length); const lower = segment.toLowerCase();
    const ratio = terms.filter((word) => lower.includes(word)).length / terms.length;
    if (ratio >= .7 && (!best || ratio > best.ratio)) best = { start, end: start + segment.length, ratio };
  }
  return best;
}
function reportMatches(text, flags) { return flags.filter((flag) => !!reportSpan(text, flag.phrase)); }
function reportHighlightedText(text, flags) {
  const source = String(text || ''); const hits = [];
  for (const flag of flags) { const span = reportSpan(source, flag.phrase); if (span) hits.push({ ...span, category: flag.category }); }
  hits.sort((a, b) => a.start - b.start || b.end - a.end); const accepted = []; let cursor = -1;
  for (const hit of hits) if (hit.start >= cursor) { accepted.push(hit); cursor = hit.end; }
  if (!accepted.length) return esc(source);
  let html = ''; cursor = 0;
  for (const hit of accepted) { html += esc(source.slice(cursor, hit.start)); html += `<mark class="flag-${esc(hit.category)}">${esc(source.slice(hit.start, hit.end))}</mark>`; cursor = hit.end; }
  return html + esc(source.slice(cursor));
}

export function auditReportTranscript(result) {
  const turns = Array.isArray(result.reportTurns) ? result.reportTurns : [];
  if (!turns.length) return '<details class="transcript"><summary><span>Chat transcript</span><small>Unavailable</small></summary><div class="transcript-body"><p class="muted">The live transcript could not be loaded while this report was generated.</p></div></details>';
  const flags = reportFlags(result.audit || {});
  const selfAssignment = result.metrics?.selfAssigned ? `<article class="turn event flagged border-efficiency"><header><b>Self-assignment violation</b><time>${esc(new Date(Number(result.metrics.selfAssignmentAt || result.metrics.assignmentAt || 0) * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: true }))} GMT+6</time></header><div>The agent assigned this conversation to themselves. Efficiency is automatically 0/10.</div><small>Prohibited assignment workflow</small></article>` : '';
  const rows = turns.map((turn) => {
    const kind = ['client','agent'].includes(turn.kind) ? turn.kind : 'event'; const matches = kind === 'agent' ? reportMatches(turn.body, flags) : [];
    const author = kind === 'client' ? (turn.authorName || 'Client') : kind === 'agent' ? (turn.authorName || 'Agent') : 'Event';
    const at = new Date(Number(turn.at || 0) * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: true }); const body = turn.body || `[${turn.partType || 'event'}]`;
    return `<article class="turn ${kind} ${matches.length ? `flagged border-${esc(matches[0].category)}` : ''}"><header><b>${esc(author)}</b><time>${esc(at)} GMT+6</time></header><div>${kind === 'agent' ? reportHighlightedText(body, flags) : esc(body)}</div>${matches.length ? `<small>Referenced in verdict · ${esc(matches.map((item) => item.label).join(' · '))}</small>` : ''}</article>`;
  }).join('');
  const count = turns.filter((turn) => turn.body && !/^\[/.test(turn.body)).length;
  return `<details class="transcript"><summary><span>Chat transcript</span><small>${count} messages · Expand</small></summary><div class="transcript-body">${selfAssignment}${rows}</div></details>`;
}
