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

export function humanEfficiencyComment(metrics, defaults = { frtSeconds: 30, artSeconds: 90, ahtSeconds: 1200 }) {
  const replies = Number(metrics.ahtMessageCount || metrics.ahtCycles?.length || 0);
  const aht = metrics.ahtSeconds == null
    ? 'AHT could not be calculated from the available assignment and reply timestamps.'
    : `Total AHT was ${minutesLabel(metrics.ahtSeconds)} across ${replies} agent ${replies === 1 ? 'reply' : 'replies'}, ${metrics.ahtHit === false ? 'above' : 'within'} the ${minutesLabel(metrics.ahtTarget || defaults.ahtSeconds)} target.`;
  if (metrics.supportLevel === 'level2') {
    return `${aht} FRT and ART were excluded because this agent is marked as Level 2 email support. ${metrics.ahtHit === false ? 'In a similar case, prepare the full answer before sending and remove repeated explanations so the complete response can be delivered sooner.' : 'For similar cases, keep using complete email-style replies without adding avoidable follow-up messages.'}`;
  }
  const frt = metrics.frtSeconds == null ? 'FRT was unavailable.' : `FRT was ${secondsLabel(metrics.frtSeconds)}, ${metrics.frtHit === false ? 'above' : 'within'} the ${secondsLabel(metrics.frtTarget || defaults.frtSeconds)} target.`;
  const cycles = Array.isArray(metrics.responseTimes) ? metrics.responseTimes.length : 0;
  const art = cycles ? `${metrics.artBreaches || 0} of ${cycles} ART response ${cycles === 1 ? 'cycle' : 'cycles'} exceeded the ${secondsLabel(metrics.artTarget || defaults.artSeconds)} target.` : 'No eligible ART response cycle was available.';
  const next = metrics.frtHit === false ? 'In a similar case, acknowledge the assignment immediately, then continue investigating while the client knows the case is being handled.' : metrics.ahtHit === false ? 'In a similar case, combine the diagnosis, policy explanation, and next step into one complete reply and avoid repeating information already given.' : (metrics.artBreaches || 0) > 0 ? 'In a similar case, send a brief progress update before the 90-second ART limit when investigation is still underway.' : 'Keep the same response cadence while making each reply complete and directly actionable.';
  return `${aht} ${frt} ${art} ${next}`;
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
  if (!turns.length) return '<section class="transcript"><h3>Chat transcript</h3><p class="muted">The live transcript could not be loaded while this report was generated.</p></section>';
  const flags = reportFlags(result.audit || {});
  const rows = turns.map((turn) => {
    const kind = ['client','agent'].includes(turn.kind) ? turn.kind : 'event'; const matches = kind === 'agent' ? reportMatches(turn.body, flags) : [];
    const author = kind === 'client' ? (turn.authorName || 'Client') : kind === 'agent' ? (turn.authorName || 'Agent') : 'Event';
    const at = new Date(Number(turn.at || 0) * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: true }); const body = turn.body || `[${turn.partType || 'event'}]`;
    return `<article class="turn ${kind} ${matches.length ? `flagged border-${esc(matches[0].category)}` : ''}"><header><b>${esc(author)}</b><time>${esc(at)} GMT+6</time></header><div>${kind === 'agent' ? reportHighlightedText(body, flags) : esc(body)}</div>${matches.length ? `<small>Referenced in verdict · ${esc(matches.map((item) => item.label).join(' · '))}</small>` : ''}</article>`;
  }).join('');
  return `<section class="transcript"><h3>Chat transcript <span>${turns.filter((turn) => turn.body && !/^\[/.test(turn.body)).length} messages</span></h3>${rows}</section>`;
}
