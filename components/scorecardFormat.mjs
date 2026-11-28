// Pure formatting helpers shared by the scorecard UI (no React, no DOM).

const num = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

// 130 -> "2m 10s", 45 -> "45s", 3900 -> "1h 5m", missing -> "n/a"
export function secondsText(value) {
  const n = num(value);
  if (n === null) return 'n/a';
  if (n < 59.5) return `${Math.round(n)}s`;
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  if (s === 60) return secondsText(Math.round(n));
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Epoch seconds -> "28 Nov 2026, 03:04:05 pm GMT+6" in Asia/Dhaka.
export function formatDhaka(epochSeconds) {
  const n = num(epochSeconds);
  if (n === null || n <= 0) return '';
  try {
    return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(n * 1000))} GMT+6`;
  } catch {
    return '';
  }
}

export function formatDhakaDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  } catch {
    return '';
  }
}

export function percentOf(scorecard) {
  const total = num(scorecard?.total);
  return total === null ? 0 : Math.max(0, Math.min(100, Math.round(total * 100)));
}

const TRACK_LABELS = { live_chat: 'L1 Live Chat', email: 'L2 Email', pstf: 'L2 PSTF' };
export function trackLabel(scorecard) {
  return TRACK_LABELS[scorecard?.track] || String(scorecard?.trackLabel || '').replace(/\s*[·.]\s*/, ' ') || 'Scorecard';
}

// tone: good | watch | risk | none
export function outcomeInfo(scorecard) {
  const outcome = scorecard?.outcome || (scorecard?.critical?.failed ? 'critical_fail' : scorecard?.passed ? 'pass' : 'fail');
  if (outcome === 'pass') return { key: 'pass', label: 'Pass', tone: 'good' };
  if (outcome === 'critical_fail') return { key: 'critical_fail', label: 'Critical failure', tone: 'risk', strong: true };
  return { key: 'fail', label: 'Fail', tone: 'risk' };
}

export function metricStatusInfo(status) {
  if (status === 'hit') return { label: 'Hit', tone: 'good' };
  if (status === 'met') return { label: 'Met', tone: 'good' };
  if (status === 'breach') return { label: 'Breach', tone: 'risk' };
  return { label: 'Unavailable', tone: 'watch' };
}

const SHORT = { frt: 'FRT', art: 'ART', aht: 'AHT', sla: 'SLA', resolution: 'Resolved' };
export function efficiencyShort(key) {
  return SHORT[key] || String(key || '').toUpperCase();
}

// Only what the stored data holds: never an invented target.
export function targetText(metric) {
  const target = num(metric?.target);
  if (target === null) return '';
  const wrap = num(metric?.targetWrap);
  if (wrap !== null) return `${secondsText(target)} to reply, ${secondsText(wrap)} wait after the reply`;
  return secondsText(target);
}

export function valueText(metric) {
  const value = num(metric?.value);
  return value === null ? 'n/a' : secondsText(value);
}

export function sourceKindLabel(kind) {
  const text = String(kind || '').toLowerCase();
  if (/correction/.test(text)) return 'Approved correction';
  if (/notice/.test(text)) return 'Notice';
  if (/faq/.test(text)) return 'FAQ';
  return String(kind || 'Source');
}

export function safeUrl(url) {
  const text = String(url || '').trim();
  return /^https?:\/\//i.test(text) ? text : '';
}

export function speakerLabel(speaker) {
  if (speaker === 'agent') return 'Agent';
  if (speaker === 'client') return 'Client';
  if (speaker === 'bot' || speaker === 'automation') return 'FundedNext AI';
  return speaker ? String(speaker) : 'Message';
}

// The object the existing evidence resolvers (deductionEvidenceTarget) expect.
export function evidenceAsDeduction(item) {
  return {
    transcriptExample: item?.quote || '',
    evidenceAt: Number(item?.at) || 0,
    evidenceSpeaker: item?.speaker === 'bot' ? 'automation' : item?.speaker || '',
    evidenceVerified: !!item?.verified,
  };
}

// Which transcript marker or ticket event an anchor points at, given the ids that really exist.
export function anchorTargetId(anchor, ids = [], turns = []) {
  const has = (id) => id !== undefined && id !== null && id !== '' && ids.some((x) => String(x) === String(id));
  if (has(anchor?.eventId)) return String(anchor.eventId);
  if (has(anchor?.id)) return String(anchor.id);
  const base = String(anchor?.id || '');
  if (/^metric-art-/.test(base)) {
    const alt = ids.find((x) => String(x) === 'metric-art');
    if (alt) return String(alt);
  }
  const at = Number(anchor?.at) || 0;
  if (at && turns.length) {
    const near = turns.filter((t) => Math.abs(Number(t.at || 0) - at) <= 2).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
    if (near) return String(near.id);
  }
  return null;
}

export function anchorLabel(anchor, many) {
  if (!many) return 'View evidence in conversation';
  const id = String(anchor?.id || '');
  if (/assignment/.test(id)) return 'View evidence in conversation: assignment';
  if (/response/.test(id)) return 'View evidence in conversation: reply';
  if (/resolved/.test(id)) return 'View evidence in conversation: resolution';
  return 'View evidence in conversation';
}

// KPI numbers for a scorecard job, computed from saved results only.
export function scorecardKpis(results = []) {
  const done = results.filter((item) => item?.status === 'completed' && item.scorecard);
  const n = done.length;
  const avg = n ? done.reduce((sum, item) => sum + percentOf(item.scorecard) , 0) / n : null;
  return {
    evaluations: n,
    average: avg === null ? '—' : `${(Math.round(avg * 10) / 10).toString().replace(/\.0$/, '')}%`,
    passRate: n ? `${Math.round((done.filter((item) => item.scorecard.passed ?? item.scorecard.outcome === 'pass').length / n) * 100)}%` : '—',
    criticalFailures: done.filter((item) => item.scorecard.critical?.failed).length,
    manualReview: done.filter((item) => item.scorecard.manualReview).length,
  };
}

export function historyJobMatches(job, filter) {
  return filter === 'legacy' ? job?.scorecard !== true : job?.scorecard === true;
}
