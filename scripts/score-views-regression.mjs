import assert from 'node:assert/strict';
import { healthTone, breachTone, formatDuration, changeInfo, kpiTiles, buildInsights, sortAgents, nextSort, trendGeometry, efficiencyName, clusterRows, formatPercent, outcomeInfo, metricLabel } from '../components/scoreHelpers.mjs';

// RAG thresholds
assert.equal(healthTone(90), 'good'); assert.equal(healthTone(100), 'good');
assert.equal(healthTone(89.9), 'warn'); assert.equal(healthTone(75), 'warn');
assert.equal(healthTone(74.9), 'bad'); assert.equal(healthTone(0), 'bad');
assert.equal(healthTone(null), 'none'); assert.equal(healthTone(undefined), 'none');
assert.equal(breachTone(10), 'good'); assert.equal(breachTone(20), 'warn'); assert.equal(breachTone(30), 'bad'); assert.equal(breachTone(null), 'none');

// Durations
assert.equal(formatDuration(130), '2m 10s'); assert.equal(formatDuration(45), '45s'); assert.equal(formatDuration(120), '2m');
assert.equal(formatDuration(3900), '1h 5m'); assert.equal(formatDuration(3600), '1h'); assert.equal(formatDuration(null), 'n/a');
assert.equal(formatPercent(72.45), '72.5%'); assert.equal(formatPercent(null), 'n/a');

// Change vs previous
let c = changeInfo(92, 90, { better: 'up' }); assert.equal(c.tone, 'good'); assert.equal(c.arrow, '↑'); assert.equal(c.text, '+2 pts');
c = changeInfo(5, 8, { better: 'down', unit: 'pts' }); assert.equal(c.tone, 'good'); assert.equal(c.arrow, '↓'); assert.equal(c.text, '-3 pts');
c = changeInfo(9, 8, { better: 'down' }); assert.equal(c.tone, 'bad');
c = changeInfo(10, 8, { better: 'neutral', unit: 'count' }); assert.equal(c.tone, 'neutral'); assert.equal(c.text, '+2');
c = changeInfo(10, 10); assert.equal(c.tone, 'neutral'); assert.equal(c.text, 'No change');
c = changeInfo(10, 8, { hasPrevious: false }); assert.equal(c.tone, 'neutral'); assert.equal(c.delta, null);
const empty = kpiTiles({ evaluated: 3, avgScore: 80, passRate: 50, criticalRate: 0, manualReviewCount: 1 }, { evaluated: 0, avgScore: null });
assert.ok(empty.every((t) => t.change.tone === 'neutral'));
assert.equal(kpiTiles({ legacy: true, evaluated: 2, avgScore: 70 }, null)[1].value, 'n/a');

// Insights
const overview = {
  evaluated: 40, avgScore: 84, passRate: 60, criticalRate: 5, criticalFailures: 2, manualReviewCount: 4,
  clusters: [
    { key: 'etiquette', name: 'Conversation Etiquette', max: 15, evaluated: 40, failed: 4, failRate: 10, keptPercent: 90, rootCauses: [{ key: 'a', label: 'Lack of Empathy / Apology', count: 4 }] },
    { key: 'fcr', name: 'FCR Breach', max: 25, evaluated: 40, failed: 14, failRate: 35, keptPercent: 65, rootCauses: [{ key: 'x', label: 'Incomplete Resolution', count: 9 }, { key: 'y', label: 'Unnecessary Holding Text', count: 5 }] },
    { key: 'efficiency', name: 'Efficiency Metrics', max: 25, evaluated: 40, failed: 8, failRate: 20, keptPercent: 80, rootCauses: [] },
  ],
  critical: [{ key: 'confidentiality', name: 'Confidentiality Breach', failed: 0 }, { key: 'incorrect_information', name: 'Incorrect Information / Resolution', failed: 2 }],
  efficiency: [{ key: 'frt', label: 'First Response Time', measured: 40, breaches: 4, breachRate: 10, avgSeconds: 28, medianSeconds: 25, targetSeconds: 30 }, { key: 'aht', label: 'Average Handling Time', measured: 30, breaches: 15, breachRate: 50, avgSeconds: 800, medianSeconds: 700, targetSeconds: 720 }],
  trend: [{ week: '2026-11-02', evaluated: 20, avgScore: 80, passRate: 50 }, { week: '2026-11-09', evaluated: 20, avgScore: 88, passRate: 70 }],
};
const previous = { evaluated: 30, avgScore: 85, passRate: 62, clusters: [{ key: 'fcr', keptPercent: 80 }, { key: 'etiquette', keptPercent: 89 }] };
const insights = buildInsights(overview, previous, { track: 'live_chat' });
const byKey = Object.fromEntries(insights.map((i) => [i.key, i.text]));
assert.match(byKey.weakest, /FCR Breach is the weakest area/); assert.match(byKey.weakest, /Incomplete Resolution \(9 times\)/);
assert.match(byKey.change, /Points kept in FCR Breach fell by 15 points/);
assert.match(byKey.efficiency, /Average Handling Time \(Live chat\) breaches most often: 50%/); assert.match(byKey.efficiency, /12m target/);
assert.match(byKey.critical, /Incorrect Information \/ Resolution is the critical check that failed most: 2 conversations/);
assert.match(byKey.manual, /4 conversations need manual review out of 40/);
assert.deepEqual(buildInsights({ evaluated: 0 }, null), []);
assert.equal(buildInsights({ ...overview, critical: [{ key: 'c', name: 'C', failed: 0 }] }, null).find((i) => i.key === 'critical').text, 'No critical check failed in this period.');
assert.ok(!buildInsights(overview, { evaluated: 0 }).some((i) => i.key === 'change'));
const legacyOv = { legacy: true, evaluated: 5, avgScore: 70, passRate: null, clusters: [{ key: 'efficiency', name: 'Efficiency', max: 10, evaluated: 5, failRate: 40, keptPercent: 60, rootCauses: [] }], critical: [], efficiency: [], manualReviewCount: 0, trend: [] };
assert.match(buildInsights(legacyOv, null)[0].text, /^Efficiency is the weakest area/);
assert.equal(clusterRows(legacyOv)[0].displayName, 'Efficiency'); assert.equal(clusterRows(overview)[2].displayName, 'Efficiency Metrics');

// Efficiency names, labels
assert.equal(efficiencyName('aht', 'email').long, 'Average Handling Time (Email)'); assert.equal(efficiencyName('sla', 'pstf').short, 'SLA');
assert.equal(metricLabel('efficiency:frt', { track: 'live_chat' }), 'First Response Time'); assert.equal(metricLabel('total'), 'Total score');
assert.equal(outcomeInfo('critical_fail').label, 'Critical failure');

// Sorting
const agents = [{ agentName: 'B', evaluated: 5, avgScore: 70, criticalFailures: 0, clusters: [{ key: 'fcr', keptPercent: 50 }] }, { agentName: 'A', evaluated: 9, avgScore: 95, criticalFailures: 2, clusters: [{ key: 'fcr', keptPercent: null }] }, { agentName: 'C', evaluated: 2, avgScore: 80, criticalFailures: 1, clusters: [] }];
assert.deepEqual(sortAgents(agents, null).map((a) => a.agentName), ['B', 'A', 'C']);
assert.deepEqual(sortAgents(agents, { key: 'agent', dir: 'asc' }).map((a) => a.agentName), ['A', 'B', 'C']);
assert.deepEqual(sortAgents(agents, { key: 'total', dir: 'desc' }).map((a) => a.agentName), ['A', 'C', 'B']);
assert.deepEqual(sortAgents(agents, { key: 'cluster:fcr', dir: 'desc' }).map((a) => a.agentName), ['B', 'A', 'C']);
assert.deepEqual(nextSort(null, 'x'), { key: 'x', dir: 'asc' }); assert.deepEqual(nextSort({ key: 'x', dir: 'asc' }, 'x'), { key: 'x', dir: 'desc' }); assert.equal(nextSort({ key: 'x', dir: 'desc' }, 'x'), null);

// Trend geometry
const g = trendGeometry(overview.trend);
assert.equal(g.avg.points.length, 2); assert.ok(g.avg.path.startsWith('M')); assert.ok(g.avg.points[1].y < g.avg.points[0].y);
assert.equal(trendGeometry([{ week: 'w', avgScore: 50, passRate: null }]).pass.points.length, 0);
assert.equal(trendGeometry([]).avg.path, '');

console.log('score views helpers ok');
