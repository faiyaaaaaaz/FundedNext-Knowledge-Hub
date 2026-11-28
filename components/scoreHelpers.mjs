// Pure helpers for the Metric Scores and Agent Scores screens. No React, no I/O.

export const HEALTH_GOOD = 90;
export const HEALTH_WARN = 75;

const isNum = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

// Share of points kept (0-100) to a health tone. Green >= 90, amber 75 to under 90, red under 75.
export function healthTone(percent) {
  if (!isNum(percent)) return 'none';
  const value = Number(percent);
  if (value >= HEALTH_GOOD) return 'good';
  if (value >= HEALTH_WARN) return 'warn';
  return 'bad';
}

export const TONE_WORD = { good: 'Healthy', warn: 'Watch', bad: 'At risk', none: 'No data' };
export const toneWord = (tone) => TONE_WORD[tone] || TONE_WORD.none;

// Breach rate (lower is better) to the same tone scale: a 10% breach rate equals 90% kept.
export function breachTone(rate) {
  if (!isNum(rate)) return 'none';
  return healthTone(100 - Number(rate));
}

export function formatPercent(value, places = 1) {
  if (!isNum(value)) return 'n/a';
  const rounded = Math.round(Number(value) * 10 ** places) / 10 ** places;
  return `${rounded}%`;
}

export function formatNumber(value) {
  if (!isNum(value)) return 'n/a';
  return Number(value).toLocaleString('en-US');
}

// 130 -> "2m 10s", 45 -> "45s", 3900 -> "1h 5m".
export function formatDuration(value) {
  if (!isNum(value)) return 'n/a';
  const total = Math.max(0, Math.round(Number(value)));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

const POINT_WORD = { pts: 'pts', count: '' };

// Change versus the previous period. `better` is 'up' or 'down' (which direction is good) or 'neutral'.
// Returns { arrow, text, tone, label } where tone is good, bad or neutral.
export function changeInfo(current, previous, { better = 'up', unit = 'pts', hasPrevious = true } = {}) {
  if (!hasPrevious || !isNum(current) || !isNum(previous)) {
    return { arrow: '', text: 'No prior data', tone: 'neutral', delta: null, label: 'No previous period to compare' };
  }
  const delta = Math.round((Number(current) - Number(previous)) * 10) / 10;
  if (delta === 0) return { arrow: '→', text: 'No change', tone: 'neutral', delta: 0, label: 'No change versus the previous period' };
  const up = delta > 0;
  const tone = better === 'neutral' ? 'neutral' : (up === (better === 'up') ? 'good' : 'bad');
  const sign = up ? '+' : '-';
  const size = Math.abs(delta);
  const suffix = unit === 'count' ? '' : ` ${POINT_WORD[unit] || unit}`;
  const text = `${sign}${size}${suffix}`;
  return { arrow: up ? '↑' : '↓', text, tone, delta, label: `${up ? 'Up' : 'Down'} ${size}${suffix} versus the previous period` };
}

// Tile definitions for one track overview. Reads only fields the API returns.
export function kpiTiles(overview, previous) {
  const hasPrev = !!(previous && previous.evaluated > 0);
  const legacy = !!overview?.legacy;
  const tiles = [
    { key: 'avg', label: 'Average score', value: formatPercent(overview?.avgScore), change: changeInfo(overview?.avgScore, previous?.avgScore, { better: 'up', hasPrevious: hasPrev }) },
    { key: 'pass', label: 'Pass rate', value: legacy ? 'n/a' : formatPercent(overview?.passRate), change: legacy ? changeInfo(null, null) : changeInfo(overview?.passRate, previous?.passRate, { better: 'up', hasPrevious: hasPrev }) },
    { key: 'critical', label: 'Critical failure rate', value: legacy ? 'n/a' : formatPercent(overview?.criticalRate), change: legacy ? changeInfo(null, null) : changeInfo(overview?.criticalRate, previous?.criticalRate, { better: 'down', hasPrevious: hasPrev }) },
    { key: 'evaluated', label: 'Conversations evaluated', value: formatNumber(overview?.evaluated), change: changeInfo(overview?.evaluated, previous?.evaluated, { better: 'neutral', unit: 'count', hasPrevious: hasPrev }) },
    { key: 'manual', label: 'Needs manual review', value: formatNumber(overview?.manualReviewCount), change: changeInfo(overview?.manualReviewCount, previous?.manualReviewCount, { better: 'down', unit: 'count', hasPrevious: hasPrev }) },
  ];
  return tiles;
}

const EFFICIENCY_NAMES = {
  frt: ['First Response Time', 'FRT'],
  art: ['Average Response Time', 'ART'],
  aht: ['Average Handling Time', 'AHT'],
  sla: ['Response SLA', 'SLA'],
  resolution: ['Resolved after response', 'Resolved'],
};
const TRACK_WORD = { live_chat: 'Live chat', email: 'Email', pstf: 'PSTF' };

export function efficiencyName(key, track = '', fallback = '') {
  const known = EFFICIENCY_NAMES[key];
  const channel = TRACK_WORD[track] || '';
  if (!known) return { long: fallback || key, short: fallback || key };
  const long = key === 'aht' && channel ? `${known[0]} (${channel})` : known[0];
  const short = key === 'aht' && channel ? `AHT ${channel}` : known[1];
  return { long, short };
}

// Targets are seconds; the Resolved metric has none.
export function targetText(seconds) {
  return isNum(seconds) ? formatDuration(seconds) : 'None';
}

export function clusterRows(overview) {
  return (overview?.clusters || []).map((cluster) => ({
    ...cluster,
    displayName: cluster.key === 'efficiency' && !overview?.legacy ? 'Efficiency Metrics' : cluster.name,
    tone: healthTone(cluster.keptPercent),
  }));
}

function topCause(cluster) {
  const causes = (cluster?.rootCauses || []).filter((cause) => cause.count > 0).sort((a, b) => b.count - a.count);
  return causes[0] || null;
}

export function topCauses(cluster, limit = 3) {
  return (cluster?.rootCauses || []).filter((cause) => cause.count > 0).sort((a, b) => b.count - a.count).slice(0, limit);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Plain-sentence insights built only from numbers present in the overview. Never invents.
export function buildInsights(overview, previous, { track = '' } = {}) {
  const out = [];
  if (!overview || !overview.evaluated) return out;
  const legacy = !!overview.legacy;
  const clusters = clusterRows(overview).filter((cluster) => cluster.evaluated > 0 && isNum(cluster.keptPercent));

  if (clusters.length) {
    const weakest = [...clusters].sort((a, b) => a.keptPercent - b.keptPercent)[0];
    const cause = topCause(weakest);
    let text = `${weakest.displayName} is the weakest area: it keeps ${formatPercent(weakest.keptPercent)} of its points, and ${formatPercent(weakest.failRate)} of ${plural(weakest.evaluated, 'evaluated conversation', 'evaluated conversations')} failed it.`;
    if (cause) text += ` The most common root cause is ${cause.label} (${plural(cause.count, 'time', 'times')}).`;
    out.push({ key: 'weakest', metric: weakest.key, failedOnly: weakest.failRate > 0, text });
  }

  if (previous && previous.evaluated > 0) {
    const candidates = [];
    if (isNum(overview.avgScore) && isNum(previous.avgScore)) candidates.push({ name: 'The average score', now: overview.avgScore, then: previous.avgScore });
    if (!legacy && isNum(overview.passRate) && isNum(previous.passRate)) candidates.push({ name: 'The pass rate', subset: 'pass', now: overview.passRate, then: previous.passRate });
    for (const cluster of clusters) {
      const before = (previous.clusters || []).find((item) => item.key === cluster.key);
      if (before && isNum(before.keptPercent)) candidates.push({ name: `Points kept in ${cluster.displayName}`, metric: cluster.key, now: cluster.keptPercent, then: before.keptPercent });
    }
    const moved = candidates.map((item) => ({ ...item, delta: Math.round((item.now - item.then) * 10) / 10 })).filter((item) => item.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    if (moved) out.push({ key: 'change', metric: moved.metric, subset: moved.subset, text: `${moved.name} ${moved.delta > 0 ? 'rose' : 'fell'} by ${Math.abs(moved.delta)} points versus the previous period, from ${formatPercent(moved.then)} to ${formatPercent(moved.now)}. This is the biggest change among the headline numbers.` });
  }

  const efficiency = (overview.efficiency || []).filter((item) => item.measured > 0 && isNum(item.breachRate));
  if (efficiency.length) {
    const worst = [...efficiency].sort((a, b) => b.breachRate - a.breachRate)[0];
    const name = efficiencyName(worst.key, track, worst.label).long;
    if (worst.breachRate > 0) out.push({ key: 'efficiency', metric: `efficiency:${worst.key}`, failedOnly: true, text: `${name} breaches most often: ${formatPercent(worst.breachRate)} of ${plural(worst.measured, 'measured conversation', 'measured conversations')} missed the ${isNum(worst.targetSeconds) ? `${formatDuration(worst.targetSeconds)} target` : 'target'}.` });
    else out.push({ key: 'efficiency', text: 'No efficiency metric breached its target in this period.' });
  }

  if (!legacy && (overview.critical || []).length) {
    const worst = [...overview.critical].sort((a, b) => b.failed - a.failed)[0];
    if (worst && worst.failed > 0) out.push({ key: 'critical', metric: worst.key, failedOnly: true, text: `${worst.name} is the critical check that failed most: ${plural(worst.failed, 'conversation', 'conversations')} (${formatPercent(worst.failed / overview.evaluated * 100)} of those evaluated).` });
    else out.push({ key: 'critical', text: 'No critical check failed in this period.' });
  }

  if (overview.manualReviewCount > 0) out.push({ key: 'manual', subset: 'manual', text: `${plural(overview.manualReviewCount, 'conversation needs', 'conversations need')} manual review out of ${formatNumber(overview.evaluated)} evaluated.` });
  return out;
}

// Trend chart geometry. Returns point coordinates inside a viewBox so the SVG stays dumb.
export function trendGeometry(trend, { width = 640, height = 220, pad = { left: 40, right: 16, top: 12, bottom: 32 } } = {}) {
  const list = Array.isArray(trend) ? trend : [];
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (index) => pad.left + (list.length <= 1 ? innerW / 2 : (index / (list.length - 1)) * innerW);
  const y = (value) => pad.top + innerH - (Math.max(0, Math.min(100, value)) / 100) * innerH;
  const series = (field) => {
    const points = list.map((item, index) => (isNum(item[field]) ? { x: Math.round(x(index) * 10) / 10, y: Math.round(y(Number(item[field])) * 10) / 10, value: Number(item[field]), week: item.week, evaluated: item.evaluated } : null));
    const kept = points.filter(Boolean);
    return { points: kept, path: kept.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ') };
  };
  const ticks = [0, 25, 50, 75, 100].map((value) => ({ value, y: Math.round(y(value) * 10) / 10 }));
  const labels = list.map((item, index) => ({ week: item.week, x: Math.round(x(index) * 10) / 10 }));
  return { width, height, pad, ticks, labels, avg: series('avgScore'), pass: series('passRate') };
}

export function trendSummary(trend) {
  const list = (trend || []).filter((item) => isNum(item.avgScore));
  if (!list.length) return 'No weekly data in this period.';
  const first = list[0];
  const last = list[list.length - 1];
  return `Weekly average score across ${plural(list.length, 'week', 'weeks')}, from ${formatPercent(first.avgScore)} for the week of ${first.week} to ${formatPercent(last.avgScore)} for the week of ${last.week}.`;
}

// Agents table. Sort keys: agent, evaluated, total, cluster:<key>, critical, eff:<key>. null direction keeps API order.
export function agentSortValue(agent, key) {
  if (key === 'agent') return String(agent.agentName || '').toLowerCase();
  if (key === 'evaluated') return agent.evaluated;
  if (key === 'total') return agent.avgScore;
  if (key === 'critical') return agent.criticalFailures;
  if (key.startsWith('cluster:')) return (agent.clusters || []).find((item) => item.key === key.slice(8))?.keptPercent;
  if (key.startsWith('eff:')) return (agent.efficiency || []).find((item) => item.key === key.slice(4))?.breachRate;
  return null;
}

export function sortAgents(agents, sort) {
  const list = [...(agents || [])];
  if (!sort || !sort.key || !sort.dir) return list;
  const factor = sort.dir === 'desc' ? -1 : 1;
  return list.map((agent, index) => ({ agent, index })).sort((a, b) => {
    const left = agentSortValue(a.agent, sort.key);
    const right = agentSortValue(b.agent, sort.key);
    const leftEmpty = left === null || left === undefined || (typeof left === 'number' && !Number.isFinite(left));
    const rightEmpty = right === null || right === undefined || (typeof right === 'number' && !Number.isFinite(right));
    if (leftEmpty && rightEmpty) return a.index - b.index;
    if (leftEmpty) return 1;
    if (rightEmpty) return -1;
    const diff = typeof left === 'string' ? left.localeCompare(right) : left - right;
    return diff === 0 ? a.index - b.index : diff * factor;
  }).map((item) => item.agent);
}

// ascending -> descending -> back to the API order.
export function nextSort(current, key) {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  if (current.dir === 'asc') return { key, dir: 'desc' };
  return null;
}

export const OUTCOME = {
  pass: { label: 'Pass', tone: 'good' },
  fail: { label: 'Fail', tone: 'warn' },
  critical_fail: { label: 'Critical failure', tone: 'bad' },
  legacy: { label: 'Old metrics', tone: 'none' },
};
export const outcomeInfo = (outcome) => OUTCOME[outcome] || { label: String(outcome || 'Unknown'), tone: 'none' };

// Conversation timestamps are shown in Asia/Dhaka.
export function dhakaDate(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'n/a';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time));
}

export function dhakaToday(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function intercomHref(conversationId) {
  return `https://app.intercom.com/a/inbox/_/inbox/search?query=${encodeURIComponent(conversationId || '')}`;
}

// Label for the metric a drawer is showing.
export function metricLabel(metric, { clusters = [], critical = [], efficiency = [], track = '', legacy = false } = {}) {
  if (metric === 'total') return 'Total score';
  if (metric.startsWith('efficiency:')) { const key = metric.slice(11); return efficiencyName(key, track, efficiency.find((item) => item.key === key)?.label).long; }
  const cluster = clusters.find((item) => item.key === metric);
  if (cluster) return cluster.key === 'efficiency' && !legacy ? 'Efficiency Metrics' : cluster.name;
  const item = critical.find((entry) => entry.key === metric);
  return item ? item.name : metric;
}
