import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  breachTone, buildInsights, clusterRows, dhakaDate, dhakaToday, efficiencyName, formatDuration, formatNumber, formatPercent,
  healthTone, intercomHref, kpiTiles, metricLabel, nextSort, outcomeInfo, sortAgents, targetText, toneWord, topCauses, trendGeometry, trendSummary,
} from './scoreHelpers.mjs';

const GLYPH = { good: '✓', warn: '!', bad: '✕', none: '' };
const L2_TABS = [{ track: 'email', label: 'Email' }, { track: 'pstf', label: 'PSTF' }];

// ---------------------------------------------------------------------------
// Data + filters
// ---------------------------------------------------------------------------
function useScoreQuery(request, action, body) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [nonce, setNonce] = useState(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  const key = JSON.stringify(body);
  useEffect(() => {
    let live = true;
    setState({ loading: true, data: null, error: '' });
    Promise.resolve()
      .then(() => requestRef.current(action, JSON.parse(key)))
      .then((data) => { if (live) setState({ loading: false, data, error: '' }); })
      .catch((err) => { if (live) setState({ loading: false, data: null, error: (err && err.message) || 'Could not load scores.' }); });
    return () => { live = false; };
  }, [action, key, nonce]);
  return { ...state, retry: () => setNonce((value) => value + 1) };
}

export function ConversationSearch({ request, onOpen }) {
  const [value, setValue] = useState('');
  const id = value.trim();
  return <section className="scv-lookup" aria-label="Conversation search">
    <label htmlFor="audit-conversation-search">Find a saved result</label>
    <input id="audit-conversation-search" type="search" inputMode="numeric" autoComplete="off"
      placeholder="Search by conversation ID" value={value} onChange={event => setValue(event.target.value)} />
    {id && (/^\d{1,40}$/.test(id)
      ? <ConversationMatches key={id} id={id} request={request} onOpen={onOpen} />
      : <p role="status">Enter a numeric conversation ID.</p>)}
  </section>;
}

function ConversationMatches({ id, request, onOpen }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const live = useRef(false);
  const latest = useRef(request);
  latest.current = request;
  useEffect(() => {
    live.current = true;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const response = await latest.current('search-results', { conversationId: id });
        if (active) setItems(response.items);
      } catch (err) { if (active) setError(err.message || 'Search failed.'); }
    }, 300);
    return () => { active = false; live.current = false; clearTimeout(timer); };
  }, [id, attempt]);
  async function open(resultId) {
    setOpening(true);
    try {
      const response = await latest.current('score-result', { resultId });
      if (live.current) onOpen(response.result);
    } catch (err) { if (live.current) setError(err.message || 'Could not open result.'); }
    finally { if (live.current) setOpening(false); }
  }
  if (error) return <InlineError message={error} onRetry={() => { setError(''); setItems(null); setAttempt(n => n + 1); }} />;
  if (!items?.length) return <p role="status">{items ? 'No saved result found for this ID.' : 'Searching…'}</p>;
  return <ul>{items.map(item => <li key={item.id}><button type="button" disabled={opening} onClick={() => open(item.id)}>
    <strong>{id}</strong><span>{item.agentName} · {new Date(item.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })} Dhaka</span><b aria-hidden="true">→</b>
  </button></li>)}</ul>;
}

function useScoreFilters(level) {
  const [range, setRange] = useState(() => ({ from: dhakaToday(-29), to: dhakaToday() }));
  const [source, setSource] = useState('scorecard');
  const [track, setTrack] = useState(level === 'L2' ? 'email' : 'live_chat');
  return { ...range, setRange: (from, to) => setRange({ from, to }), source, setSource, track, setTrack };
}

function FilterBar({ level, filters, DateFilter }) {
  const { from, to, setRange, source, setSource, track, setTrack } = filters;
  const tabs = level === 'L2' && source === 'scorecard' ? L2_TABS : null;
  function onTabKey(event, index) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTrack(next.track);
    const node = event.currentTarget.parentElement.querySelector(`[data-track="${next.track}"]`);
    if (node) node.focus();
  }
  return (
    <div className="scv-filters">
      <div className="scv-filter-field">
        {DateFilter ? (
          <DateFilter from={from} to={to} onApply={(nextFrom, nextTo) => setRange(nextFrom, nextTo)} />
        ) : (
          <div className="scv-dates">
            <label><span>From</span><input type="date" value={from} max={to} onChange={(event) => event.target.value && setRange(event.target.value, to)} /></label>
            <label><span>To</span><input type="date" value={to} min={from} onChange={(event) => event.target.value && setRange(from, event.target.value)} /></label>
          </div>
        )}
      </div>
      <div className="scv-segment" role="group" aria-label="Evaluation source">
        <button type="button" aria-pressed={source === 'scorecard'} className={source === 'scorecard' ? 'active' : ''} onClick={() => setSource('scorecard')}>Scorecard</button>
        <button type="button" aria-pressed={source === 'legacy'} className={source === 'legacy' ? 'active' : ''} onClick={() => setSource('legacy')}>Old Metrics Evaluations</button>
      </div>
      {tabs && (
        <div className="scv-tabs" role="tablist" aria-label="Channel">
          {tabs.map((tab, index) => (
            <button key={tab.track} type="button" role="tab" data-track={tab.track} aria-selected={track === tab.track} tabIndex={track === tab.track ? 0 : -1} className={track === tab.track ? 'active' : ''} onClick={() => setTrack(tab.track)} onKeyDown={(event) => onTabKey(event, index)}>{tab.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function pickTrack(data, wanted, source) {
  const list = data?.tracks || [];
  if (source === 'legacy') return list[0] || null;
  return list.find((item) => item.track === wanted) || list[0] || null;
}

function Skeleton({ rows = 4, tiles = false }) {
  return (
    <div className="scv-skeleton" role="status" aria-label="Loading scores">
      {tiles && <div className="scv-skel-tiles">{[0, 1, 2, 3, 4].map((i) => <span key={i} className="scv-skel scv-skel-tile" />)}</div>}
      {Array.from({ length: rows }).map((_, i) => <span key={i} className="scv-skel scv-skel-row" style={{ width: `${100 - (i % 3) * 9}%` }} />)}
    </div>
  );
}

function InlineError({ message, onRetry }) {
  return (
    <div className="scv-error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onRetry}>Try again</button>
    </div>
  );
}

function Chip({ tone = 'none', children, title }) {
  return <span className={`scv-pill ${tone}`} title={title}>{GLYPH[tone] ? <i aria-hidden="true">{GLYPH[tone]}</i> : null}{children}</span>;
}

// ---------------------------------------------------------------------------
// Metric Scores
// ---------------------------------------------------------------------------
function Kpis({ overview, previous }) {
  return (
    <div className="scv-kpis">
      {kpiTiles(overview, previous).map((tile) => (
        <div key={tile.key} className="scv-kpi">
          <span className="scv-kpi-label">{tile.label}</span>
          <strong>{tile.value}</strong>
          <span className={`scv-delta ${tile.change.tone}`} aria-label={tile.change.label}>
            {tile.change.arrow && <i aria-hidden="true">{tile.change.arrow}</i>}
            {tile.change.text}
            {tile.change.delta !== null && <small> vs previous</small>}
          </span>
        </div>
      ))}
    </div>
  );
}

function HealthCard({ cluster, legacy }) {
  const { tone } = cluster;
  const kept = cluster.keptPercent;
  const causes = topCauses(cluster, 3);
  return (
    <article className="scv-health-card">
      <header>
        <h4>{cluster.displayName}</h4>
        <span className="scv-max">{legacy ? 'Out of 10' : `${cluster.max} points`}</span>
      </header>
      <div className="scv-health-main">
        <strong>{formatPercent(kept)}</strong>
        <span className="scv-health-sub">of points kept</span>
        <Chip tone={tone}>{toneWord(tone)}</Chip>
      </div>
      <div className={`scv-bar ${tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={kept === null || kept === undefined ? undefined : kept} aria-label={`${cluster.displayName}: ${formatPercent(kept)} of points kept, ${toneWord(tone)}`}>
        <span style={{ width: `${Math.max(0, Math.min(100, Number(kept) || 0))}%` }} />
        <b className="scv-tick" style={{ left: '75%' }} aria-hidden="true" />
        <b className="scv-tick" style={{ left: '90%' }} aria-hidden="true" />
      </div>
      <dl className="scv-health-stats">
        <div><dt>Fail rate</dt><dd>{formatPercent(cluster.failRate)}</dd></div>
        <div><dt>Evaluated</dt><dd>{formatNumber(cluster.evaluated)}</dd></div>
        {legacy && <div><dt>Average</dt><dd>{cluster.avgPoints === null || cluster.avgPoints === undefined ? 'n/a' : `${cluster.avgPoints} of 10`}</dd></div>}
      </dl>
      {!legacy && (
        <div className="scv-causes">
          <span className="scv-causes-title">Top root causes</span>
          {causes.length ? (
            <ul>{causes.map((cause) => <li key={cause.key}><span>{cause.label}</span><b>{cause.count}</b></li>)}</ul>
          ) : (
            <p>{cluster.key === 'efficiency' ? 'Measured by the system, see Efficiency Metrics below.' : 'No root causes marked.'}</p>
          )}
        </div>
      )}
    </article>
  );
}

function CriticalStrip({ items }) {
  if (!items?.length) return null;
  return (
    <section className="scv-section" aria-labelledby="scv-critical-title">
      <h3 id="scv-critical-title">Critical checks</h3>
      <ul className="scv-critical">
        {items.map((item) => (
          <li key={item.key}>
            <span>{item.name}</span>
            {item.failed > 0 ? <Chip tone="bad">{item.failed} failed</Chip> : <Chip tone="good">None</Chip>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EfficiencyPanel({ items, track }) {
  if (!items?.length) return null;
  return (
    <section className="scv-section" aria-labelledby="scv-eff-title">
      <h3 id="scv-eff-title">Efficiency Metrics</h3>
      <div className="scv-table-wrap">
        <table className="scv-table scv-eff-table">
          <thead>
            <tr><th scope="col">Metric</th><th scope="col" className="num">Measured</th><th scope="col" className="num">Breach rate</th><th scope="col" className="num">Average</th><th scope="col" className="num">Median</th><th scope="col" className="num">Target</th></tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const tone = breachTone(item.breachRate);
              return (
                <tr key={item.key}>
                  <th scope="row">{efficiencyName(item.key, track, item.label).long}</th>
                  <td className="num">{formatNumber(item.measured)}</td>
                  <td className="num"><Chip tone={tone}>{formatPercent(item.breachRate)}</Chip></td>
                  <td className="num">{formatDuration(item.avgSeconds)}</td>
                  <td className="num">{formatDuration(item.medianSeconds)}</td>
                  <td className="num">{targetText(item.targetSeconds)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TrendChart({ trend }) {
  const geo = useMemo(() => trendGeometry(trend), [trend]);
  const hasPass = geo.pass.points.length > 0;
  if (!geo.avg.points.length) return <p className="scv-muted">No weekly data in this period.</p>;
  const step = Math.ceil(geo.labels.length / 8);
  return (
    <div className="scv-trend">
      <div className="scv-legend" aria-hidden="true">
        <span><i className="line avg" />Average score</span>
        {hasPass && <span><i className="line pass" />Pass rate</span>}
      </div>
      <svg viewBox={`0 0 ${geo.width} ${geo.height}`} role="img" aria-label={trendSummary(trend)} className="scv-trend-svg">
        {geo.ticks.map((tick) => (
          <g key={tick.value}>
            <line x1={geo.pad.left} x2={geo.width - geo.pad.right} y1={tick.y} y2={tick.y} className="grid" />
            <text x={geo.pad.left - 8} y={tick.y + 4} textAnchor="end" className="axis">{tick.value}%</text>
          </g>
        ))}
        {geo.labels.map((label, index) => (index % step === 0 ? <text key={label.week} x={label.x} y={geo.height - 10} textAnchor="middle" className="axis">{label.week.slice(5)}</text> : null))}
        <path d={geo.avg.path} className="series avg" fill="none" />
        {hasPass && <path d={geo.pass.path} className="series pass" fill="none" />}
        {geo.avg.points.map((point) => <circle key={`a${point.week}`} cx={point.x} cy={point.y} r="3.5" className="dot avg"><title>{`Week of ${point.week}: average score ${formatPercent(point.value)}, ${point.evaluated} evaluated`}</title></circle>)}
        {hasPass && geo.pass.points.map((point) => <rect key={`p${point.week}`} x={point.x - 3.5} y={point.y - 3.5} width="7" height="7" className="dot pass"><title>{`Week of ${point.week}: pass rate ${formatPercent(point.value)}`}</title></rect>)}
      </svg>
      <details className="scv-data-table">
        <summary>View trend as a table</summary>
        <table className="scv-table">
          <thead><tr><th scope="col">Week starting</th><th scope="col" className="num">Evaluated</th><th scope="col" className="num">Average score</th>{hasPass && <th scope="col" className="num">Pass rate</th>}</tr></thead>
          <tbody>{trend.map((row) => <tr key={row.week}><th scope="row">{row.week}</th><td className="num">{row.evaluated}</td><td className="num">{formatPercent(row.avgScore)}</td>{hasPass && <td className="num">{formatPercent(row.passRate)}</td>}</tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

function MetricTrack({ track, source }) {
  const overview = track.overview || {};
  const previous = track.previous || null;
  const legacy = source === 'legacy' || !!overview.legacy;
  const insights = useMemo(() => buildInsights(overview, previous, { track: track.track }), [overview, previous, track.track]);
  const clusters = useMemo(() => clusterRows(overview), [overview]);
  return (
    <section className="scv-track" aria-label={track.trackLabel}>
      <div className="scv-track-head">
        <h2>{legacy ? 'Old Metrics Evaluations' : track.trackLabel}</h2>
        {legacy && <p className="scv-muted">Quality, Efficiency and Complexity scored out of 10 on conversations audited before the scorecard.</p>}
      </div>
      {!overview.evaluated ? (
        <p className="scv-empty">No evaluated conversations in this period.</p>
      ) : (
        <>
          <Kpis overview={overview} previous={previous} />
          <section className="scv-section" aria-labelledby={`scv-health-${track.track}`}>
            <h3 id={`scv-health-${track.track}`}>Health by metric</h3>
            <div className="scv-health-grid">{clusters.map((cluster) => <HealthCard key={cluster.key} cluster={cluster} legacy={legacy} />)}</div>
            <p className="scv-key">Share of points kept: <Chip tone="good">90% or more</Chip> <Chip tone="warn">75% to under 90%</Chip> <Chip tone="bad">Under 75%</Chip></p>
          </section>
          {!legacy && <CriticalStrip items={overview.critical} />}
          {!legacy && <EfficiencyPanel items={overview.efficiency} track={track.track} />}
          <section className="scv-section" aria-labelledby={`scv-trend-${track.track}`}>
            <h3 id={`scv-trend-${track.track}`}>Weekly trend</h3>
            <TrendChart trend={overview.trend || []} />
          </section>
          <section className="scv-section" aria-labelledby={`scv-insights-${track.track}`}>
            <h3 id={`scv-insights-${track.track}`}>Insights</h3>
            {insights.length ? <ul className="scv-insights">{insights.map((item) => <li key={item.key}>{item.text}</li>)}</ul> : <p className="scv-muted">Not enough data for insights.</p>}
          </section>
        </>
      )}
    </section>
  );
}

export function MetricScoresView({ level = 'L1', request, onOpenResult, DateFilter }) {
  const filters = useScoreFilters(level);
  const query = useScoreQuery(request, 'score-overview', { level, from: filters.from, to: filters.to, source: filters.source });
  const track = pickTrack(query.data, filters.track, filters.source);
  return (
    <div className="scv-view" data-level={level}>
      <FilterBar level={level} filters={filters} DateFilter={DateFilter} />
      <div className="scv-body" role={level === 'L2' && filters.source === 'scorecard' ? 'tabpanel' : undefined}>
        {query.loading ? <Skeleton tiles rows={5} />
          : query.error ? <InlineError message={query.error} onRetry={query.retry} />
            : track ? <MetricTrack track={track} source={filters.source} />
              : <p className="scv-empty">No scores in this period.</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent Scores
// ---------------------------------------------------------------------------
function ScoreChip({ value, tone, label, onClick, suffix = '%' }) {
  const has = value !== null && value !== undefined && Number.isFinite(Number(value));
  const text = has ? `${Math.round(Number(value) * 10) / 10}${suffix}` : 'n/a';
  return (
    <button type="button" className={`scv-chip ${tone}`} onClick={onClick} aria-label={`${label}: ${text}, ${toneWord(tone)}. Show conversations`} title={`${label}: ${toneWord(tone)}`}>
      {GLYPH[tone] ? <i aria-hidden="true">{GLYPH[tone]}</i> : null}{text}
    </button>
  );
}

function unionBy(list, pick) {
  const seen = new Map();
  for (const agent of list) for (const item of pick(agent) || []) if (!seen.has(item.key)) seen.set(item.key, item);
  return [...seen.values()];
}

function AgentsTable({ group, source, onOpen }) {
  const [detailed, setDetailed] = useState(false);
  const [sort, setSort] = useState(null);
  const agents = useMemo(() => sortAgents(group.agents, sort), [group.agents, sort]);
  const legacy = source === 'legacy';
  const clusters = useMemo(() => unionBy(group.agents, (agent) => agent.clusters), [group.agents]);
  const criticalDefs = useMemo(() => unionBy(group.agents, (agent) => agent.critical), [group.agents]);
  const efficiency = useMemo(() => unionBy(group.agents, (agent) => agent.efficiency), [group.agents]);
  const clusterName = (cluster) => (cluster.key === 'efficiency' && !legacy ? 'Efficiency Metrics' : cluster.name);
  const open = (agent, metric, failedOnly = false) => onOpen({
    track: group.track, trackLabel: group.trackLabel, agentId: agent.agentId, agentName: agent.agentName, metric, failedOnly,
    label: metricLabel(metric, { clusters: agent.clusters, critical: agent.critical, efficiency: agent.efficiency, track: group.track, legacy }),
  });
  const sortable = (key, label, className = '') => (
    <th scope="col" className={className} aria-sort={sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="scv-sort" onClick={() => setSort((current) => nextSort(current, key))}>
        {label}<i aria-hidden="true">{sort?.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</i>
      </button>
    </th>
  );
  return (
    <>
    <div className="scv-segment" role="group" aria-label="Table detail"><button type="button" className={!detailed ? "active" : ""} aria-pressed={!detailed} onClick={() => setDetailed(false)}>Summary</button><button type="button" className={detailed ? "active" : ""} aria-pressed={detailed} onClick={() => setDetailed(true)}>Metric breakdown</button></div>
    <div className="scv-table-wrap scv-agents-wrap">
      <table className="scv-table scv-agents">
        <thead>
          <tr>
            {sortable('agent', 'Agent', 'sticky')}
            {sortable('evaluated', 'Evaluated', 'num')}
            {sortable('total', 'Total score', 'num')}
            {detailed && clusters.map((cluster) => sortable(`cluster:${cluster.key}`, clusterName(cluster), 'num'))}
            {!legacy && sortable('critical', 'Critical', 'num')}
            {detailed && !legacy && <th scope="col">Efficiency</th>}
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.agentId}>
              <th scope="row" className="sticky">{agent.agentName}</th>
              <td className="num">{formatNumber(agent.evaluated)}</td>
              <td className="num"><ScoreChip value={agent.avgScore} tone={healthTone(agent.avgScore)} label={`${agent.agentName} total score`} onClick={() => open(agent, 'total')} /></td>
              {detailed && clusters.map((def) => {
                const cluster = (agent.clusters || []).find((item) => item.key === def.key);
                return (
                  <td key={def.key} className="num">
                    {cluster && cluster.evaluated > 0
                      ? <ScoreChip value={cluster.keptPercent} tone={healthTone(cluster.keptPercent)} label={`${agent.agentName}, ${clusterName(def)}`} onClick={() => open(agent, def.key)} />
                      : <span className="scv-muted">n/a</span>}
                  </td>
                );
              })}
              {!legacy && (
                <td className="num">
                  {(() => {
                    const failed = (agent.critical || []).filter((item) => item.failed > 0);
                    if (!failed.length) return <Chip tone="good">None</Chip>;
                    return (
                      <span className="scv-chip-row">
                        {failed.map((item) => (
                          <button key={item.key} type="button" className="scv-chip bad" title={item.name} aria-label={`${agent.agentName}, ${item.name}: ${item.failed} failed. Show conversations`} onClick={() => open(agent, item.key, true)}>
                            <i aria-hidden="true">✕</i>{item.name.length > 22 ? `${item.name.slice(0, 20)}...` : item.name} {item.failed}
                          </button>
                        ))}
                      </span>
                    );
                  })()}
                </td>
              )}
              {detailed && !legacy && (
                <td>
                  <span className="scv-chip-row">
                    {efficiency.map((def) => {
                      const item = (agent.efficiency || []).find((entry) => entry.key === def.key);
                      if (!item || !item.measured) return null;
                      const name = efficiencyName(def.key, group.track, def.label).short;
                      const tone = breachTone(item.breachRate);
                      return (
                        <button key={def.key} type="button" className={`scv-chip ${tone}`} aria-label={`${agent.agentName}, ${name}: ${formatPercent(item.breachRate)} breach rate. Show conversations`} title={`${name}: ${formatPercent(item.breachRate)} breach rate over ${item.measured} measured`} onClick={() => open(agent, `efficiency:${def.key}`, item.breaches > 0)}>
                          {GLYPH[tone] ? <i aria-hidden="true">{GLYPH[tone]}</i> : null}{name} {formatPercent(item.breachRate, 0)}
                        </button>
                      );
                    })}
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}

function efficiencyChip(item, track) {
  const tone = item.status === 'hit' ? 'good' : item.status === 'breach' ? 'bad' : 'none';
  const word = item.status === 'hit' ? 'met' : item.status === 'breach' ? 'breach' : 'not measured';
  return <Chip key={item.key} tone={tone} title={`Target ${targetText(item.target)}`}>{efficiencyName(item.key, track, item.label).short} {item.value === null || item.value === undefined ? '' : `${formatDuration(item.value)} `}{word}</Chip>;
}

function metricLine(item, metric, track) {
  if (item.track === 'legacy') return <span>{metric === 'total' ? 'Final score' : 'Score'} <b>{Number.isFinite(item.metricScore) ? `${item.metricScore} of ${item.metricMax}` : 'n/a'}</b></span>;
  if (metric === 'total') return <span>Total score <b>{formatPercent(item.total)}</b></span>;
  if (metric.startsWith('efficiency:')) {
    const target = (item.efficiency || []).find((entry) => entry.key === metric.slice(11))?.target;
    return <span>Measured <b>{item.metricScore === null || item.metricScore === undefined ? 'n/a' : formatDuration(item.metricScore)}</b> against a target of <b>{targetText(target)}</b></span>;
  }
  if (item.metricMax !== null && item.metricMax !== undefined) return <span>Score <b>{item.metricScore} of {item.metricMax} points</b> <Chip tone={item.metricFailed ? 'bad' : 'good'}>{item.metricFailed ? 'Failed' : 'Met'}</Chip></span>;
  return <span>This check <Chip tone={item.metricFailed ? 'bad' : 'good'}>{item.metricFailed ? 'Failed' : 'Clear'}</Chip></span>;
}

function ConversationRow({ item, metric, track, busy, onOpen }) {
  const outcome = outcomeInfo(item.outcome);
  return (
    <li className="scv-conv">
      <button type="button" className="scv-conv-main" onClick={() => onOpen(item)} disabled={busy} aria-label={`Open conversation ${item.conversationId} review`}>
        <span className="scv-conv-top">
          <span className="scv-conv-date">{dhakaDate(item.conversationDate)}</span>
          <code>{item.conversationId}</code>
          {item.track !== 'legacy' && <span className="scv-conv-total">Total {formatPercent(item.total)}</span>}
          <Chip tone={outcome.tone}>{outcome.label}</Chip>
          {item.manualReview && <Chip tone="warn">Manual review</Chip>}
        </span>
        <span className="scv-conv-metric">{metricLine(item, metric, track)}</span>
        {item.markedRootCauses?.length > 0 && <span className="scv-conv-causes">{item.markedRootCauses.map((label) => <span key={label} className="scv-tag">{label}</span>)}</span>}
        {item.efficiency?.length > 0 && <span className="scv-conv-eff">{item.efficiency.map((entry) => efficiencyChip(entry, track))}</span>}
        {busy && <span className="scv-muted">Opening...</span>}
      </button>
      <a className="scv-conv-link" href={intercomHref(item.conversationId)} target="_blank" rel="noopener noreferrer">Open in Intercom <span aria-hidden="true">↗</span></a>
    </li>
  );
}

function ScoreDrawer({ target, level, from, to, source, request, onOpenResult, onClose }) {
  const [shown, setShown] = useState(false);
  const [failedOnly, setFailedOnly] = useState(!!target.failedOnly);
  const [opening, setOpening] = useState('');
  const [rowError, setRowError] = useState('');
  const closing = useRef(false);
  const panel = useRef(null);
  const closeButton = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const query = useScoreQuery(request, 'score-conversations', { level, track: target.track, agentId: target.agentId, metric: target.metric, from, to, source, failedOnly });

  function dismiss() {
    if (closing.current) return;
    closing.current = true;
    setShown(false);
    const reduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => closeRef.current(), reduced ? 0 : 460);
  }
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    const previous = document.activeElement;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => { setShown(true); if (closeButton.current) closeButton.current.focus(); }));
    function onKey(event) {
      // The review modal opens above this drawer; Escape belongs to it while it is open.
      if (document.querySelector('.audit-modal-backdrop')) return;
      if (event.key === 'Escape') { event.preventDefault(); dismissRef.current(); return; }
      if (event.key === 'Tab' && panel.current) {
        const nodes = [...panel.current.querySelectorAll('button:not([disabled]), a[href], input, [tabindex]:not([tabindex="-1"])')];
        if (!nodes.length) return;
        const first = nodes[0]; const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', onKey); if (previous && previous.focus) previous.focus(); };
  }, []);

  async function openItem(item) {
    setRowError('');
    setOpening(String(item.resultId));
    try {
      const response = await request('score-result', { resultId: item.resultId });
      onOpenResult(response.result);
    } catch (err) {
      setRowError((err && err.message) || 'Could not open this result.');
    } finally {
      setOpening('');
    }
  }

  const data = query.data;
  return createPortal(
    <div className={`scv-drawer-root ${shown ? 'open' : ''}`}>
      <div className="scv-backdrop" onMouseDown={dismiss} aria-hidden="true" />
      <aside className="scv-drawer" role="dialog" aria-modal="true" aria-labelledby="scv-drawer-title" ref={panel}>
        <header className="scv-drawer-head">
          <div>
            <h2 id="scv-drawer-title">{target.agentName}</h2>
            <p>{target.label}<span className="scv-dot-sep" aria-hidden="true"> / </span>{target.trackLabel}</p>
            <p className="scv-muted">{from} to {to}{data ? `, ${data.count} of ${data.totalForAgent} conversations` : ''}</p>
          </div>
          <button type="button" className="scv-close" onClick={dismiss} aria-label="Close" ref={closeButton}>×</button>
        </header>
        <div className="scv-drawer-tools">
          <button type="button" role="switch" aria-checked={failedOnly} className={`scv-switch ${failedOnly ? 'on' : ''}`} onClick={() => setFailedOnly((value) => !value)}>
            <span className="scv-switch-track" aria-hidden="true"><span /></span>Show only failed
          </button>
        </div>
        <div className="scv-drawer-body">
          {rowError && <InlineError message={rowError} onRetry={() => setRowError('')} />}
          {query.loading ? <Skeleton rows={6} />
            : query.error ? <InlineError message={query.error} onRetry={query.retry} />
              : data && data.items.length ? <ul className="scv-conv-list">{data.items.map((item) => <ConversationRow key={item.resultId} item={item} metric={target.metric} track={target.track} busy={opening === String(item.resultId)} onOpen={openItem} />)}</ul>
                : <p className="scv-empty">{failedOnly ? 'No failed conversations for this metric.' : 'No conversations for this metric in this period.'}</p>}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

export function AgentScoresView({ level = 'L1', request, onOpenResult, DateFilter }) {
  const filters = useScoreFilters(level);
  const [drawer, setDrawer] = useState(null);
  const query = useScoreQuery(request, 'score-agents', { level, from: filters.from, to: filters.to, source: filters.source });
  const group = pickTrack(query.data, filters.track, filters.source);
  const idle = query.data?.noEvaluations || [];
  return (
    <div className="scv-view" data-level={level}>
      <FilterBar level={level} filters={filters} DateFilter={DateFilter} />
      <div className="scv-body" role={level === 'L2' && filters.source === 'scorecard' ? 'tabpanel' : undefined}>
        {query.loading ? <Skeleton rows={7} />
          : query.error ? <InlineError message={query.error} onRetry={query.retry} />
            : (
              <section className="scv-track" aria-label={group?.trackLabel || 'Agent scores'}>
                <div className="scv-track-head">
                  <h2>{filters.source === 'legacy' ? 'Old Metrics Evaluations' : group?.trackLabel || 'Agent scores'}</h2>
                  <p className="scv-muted">Select a score to see the conversations behind it. Weakest agents are listed first.</p>
                </div>
                {group && group.agents.length ? <AgentsTable key={`${group.track}-${filters.source}`} group={group} source={filters.source} onOpen={setDrawer} /> : <p className="scv-empty">No agents were evaluated in this period.</p>}
                {idle.length > 0 && (
                  <details className="scv-idle">
                    <summary>No evaluations in this period ({idle.length})</summary>
                    <ul>{idle.map((agent) => <li key={agent.agentId}>{agent.agentName}</li>)}</ul>
                  </details>
                )}
              </section>
            )}
      </div>
      {drawer && <ScoreDrawer key={`${drawer.track}-${drawer.agentId}-${drawer.metric}`} target={drawer} level={level} from={filters.from} to={filters.to} source={filters.source} request={request} onOpenResult={onOpenResult} onClose={() => setDrawer(null)} />}
    </div>
  );
}
