import { useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';

function Logo() {
  return <svg className="audit-logo" viewBox="12 15 41 32" aria-hidden="true"><path d="M15 19h13v5.4h-7.4v4.1H27v5.3h-6.4V45H15zM31 19h5.1l9 12.4V19h5.6v26h-5.1l-9-12.3V45H31z"/><path className="accent" d="M41.4 19H50.7v9.3z"/></svg>;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(value)) + ' GMT+6';
}

function today(offset = 0) {
  const date = new Date(Date.now() + offset * 86400000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function StatusOrb({ state = 'checking' }) {
  return <span className={`audit-status-orb ${state}`} aria-hidden="true"><i/><i/><b>{state === 'healthy' ? '✓' : state === 'offline' ? '!' : '•'}</b></span>;
}

function Metric({ label, value, detail, tone = '' }) {
  return <div className={`audit-metric ${tone}`}><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

function ScoreRing({ value }) {
  const score = Math.max(0, Math.min(10, Number(value) || 0));
  return <div className="score-ring" style={{ '--score': `${score * 10}%` }}><span><b>{score.toFixed(2).replace(/\.00$/, '')}</b><small>/10</small></span></div>;
}

function ResultCard({ result }) {
  const [open, setOpen] = useState(false);
  if (result.status !== 'completed') return <article className={`audit-result-card ${result.status}`}><div className="result-summary"><div><span>Conversation {result.conversationId}</span><h3>{result.status === 'skipped' ? 'Excluded from scoring' : 'Audit could not complete'}</h3><p>{result.skipReason || result.error}</p></div><span className="result-state">{result.status}</span></div></article>;
  const audit = result.audit || {};
  return <article className={`audit-result-card ${open ? 'open' : ''}`}>
    <button className="result-summary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <div className="result-agent"><span>Conversation {result.conversationId}</span><h3>{result.agentName}</h3><p>{audit.primaryIssue || 'Conversation audit'}</p></div>
      <div className="result-mini-scores"><span><small>Quality</small><b>{audit.quality}</b></span><span><small>Efficiency</small><b>{audit.efficiency}</b></span><span><small>Process</small><b>{audit.complexity}</b></span></div>
      <ScoreRing value={audit.finalScore}/><i className="result-chevron">{open ? '−' : '+'}</i>
    </button>
    {open && <div className="result-detail">
      <div className="result-callout"><span>Main finding</span><p>{audit.mainFinding}</p></div>
      <div className="result-grid">
        <section><span>Quality</span><p>{audit.qualityComment}</p></section>
        <section><span>Efficiency</span><p>{audit.efficiencyComment}</p></section>
        <section><span>Process &amp; judgment</span><p>{audit.complexityComment}</p></section>
        <section><span>Handoff</span><p>{audit.handoffSummary || 'No handoff concern recorded.'}</p></section>
        <section><span>Accuracy</span><p>{audit.accuracyFinding}</p></section>
        <section><span>Continuity</span><p>{audit.continuityFinding}</p></section>
      </div>
      <div className="coaching-block"><span>Coaching actions</span><ol>{(audit.coachingActions || []).map((item, index) => <li key={index}>{item}</li>)}</ol><b>Goal</b><p>{audit.goal}</p></div>
      <div className="result-foot"><span className={audit.manualReview ? 'review-needed' : 'review-clear'}>{audit.manualReview ? 'Manual review required' : 'Automated review complete'}</span><span>{audit.confidence}% confidence</span><span>{result.model}</span><a href={result.intercomLink} target="_blank" rel="noreferrer">Open in Intercom ↗</a></div>
    </div>}
  </article>;
}

export default function Audits() {
  const [session, setSession] = useState('');
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState('control');
  const [conversationIds, setConversationIds] = useState('');
  const [selectedAgents, setSelectedAgents] = useState([]);
  const [agentSearch, setAgentSearch] = useState('');
  const [from, setFrom] = useState(today(-6));
  const [to, setTo] = useState(today());
  const [sampleSize, setSampleSize] = useState(10);
  const [customSample, setCustomSample] = useState('');
  const [currentJob, setCurrentJob] = useState(null);
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [syncingAgents, setSyncingAgents] = useState(false);
  const [enabledDraft, setEnabledDraft] = useState([]);
  const [accessDraft, setAccessDraft] = useState('');
  const [modelsDraft, setModelsDraft] = useState('');
  const [savingAdmin, setSavingAdmin] = useState('');
  const stopRef = useRef(false);
  const processingRef = useRef(false);
  const directMode = conversationIds.trim().length > 0;

  const headers = (json = false) => ({ ...(json ? { 'Content-Type': 'application/json' } : {}), 'x-app-session': session });
  const enabledAgents = useMemo(() => (data?.agents || []).filter((agent) => (data?.enabledAgentIds || []).includes(agent.id)), [data]);
  const visibleAgents = useMemo(() => enabledAgents.filter((agent) => `${agent.name} ${agent.email}`.toLowerCase().includes(agentSearch.toLowerCase())), [enabledAgents, agentSearch]);
  const completedResults = results.filter((item) => item.status === 'completed');

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' && new URLSearchParams(window.location.search).get('preview') === '1') {
      const previewAgents = [
        { id: '101', name: 'Allen Fletcher', email: 'allen@nextventures.io', hasInboxSeat: true },
        { id: '102', name: 'Bella Calhoun', email: 'bella@nextventures.io', hasInboxSeat: true },
        { id: '103', name: 'Mark Maxwell', email: 'mark@nextventures.io', hasInboxSeat: true }
      ];
      setSession('preview'); setData({ access: { allowed: true, canManage: true, config: { emails: ['faiyaz@nextventures.io'] } }, agents: previewAgents, enabledAgentIds: previewAgents.map((agent) => agent.id), models: ['gemini-3.5-flash-lite','gemini-3.8-flash'], connection: { intercomConfigured: true, geminiKeyCount: 3 }, thresholds: { frtSeconds: 30, artSeconds: 90, ahtSeconds: 1200 }, jobs: [], rubricVersion: 'preview' });
      setSelectedAgents(['101']); setEnabledDraft(previewAgents.map((agent) => agent.id)); setAccessDraft('faiyaz@nextventures.io'); setModelsDraft('gemini-3.5-flash-lite\ngemini-3.8-flash');
      setHealth({ state: 'healthy', checkedAt: new Date().toISOString(), intercom: { connected: true, detail: 'FundedNext workspace connected' }, healthyGeminiKeys: 3, gemini: [{ connected: true },{ connected: true },{ connected: true }] }); setLoading(false);
      if (new URLSearchParams(window.location.search).get('demo') === 'results') {
        const previewJob = { id: 184, status: 'completed', mode: 'sample', stage: 'Audit completed', total: 10, processed: 10, completed: 9, skipped: 1, failed: 0, evaluations: 10, updatedAt: new Date().toISOString() };
        const previewResults = [{ id: 'r1', status: 'completed', conversationId: '129503847', agentId: '101', agentName: 'Allen Fletcher', model: 'gemini-3.5-flash-lite', intercomLink: '#', audit: { quality: 9, efficiency: 10, complexity: 8, finalScore: 9, primaryIssue: 'Performance Reward timeline', mainFinding: 'The answer was accurate and efficient, but the transfer could have explained ownership more clearly.', qualityComment: 'Accurate, warm and directly answered the client.', efficiencyComment: 'No concerns. FRT, ART and AHT met the confirmed targets.', complexityComment: 'The transfer was correct, but the receiving team and expected timeline were not stated.', handoffSummary: 'Allen reviewed the bot context and transferred the case without making the client repeat details. The destination team was not named.', accuracyFinding: 'The explanation matched the active FAQ and Notice evidence.', continuityFinding: 'The pre-chat context was used correctly.', coachingActions: ['Name the receiving team before transferring.', 'Give the client an expected update window.'], goal: 'Make every transfer feel owned, predictable and effortless for the client.', manualReview: false, confidence: 94 } }];
        setCurrentJob(previewJob); setResults(previewResults); setView('results');
      }
      return;
    }
    const token = localStorage.getItem('appSession') || '';
    setSession(token);
    if (!token) { setLoading(false); return; }
    bootstrap(token);
    return () => { stopRef.current = true; };
  }, []);

  useEffect(() => {
    if (!running) { setElapsed(0); return; }
    const started = Date.now(); const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);

  async function request(action, body = {}, token = session) {
    const response = await fetch('/api/audits', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session': token }, body: JSON.stringify({ action, ...body }) });
    const result = await response.json();
    if (response.status === 401) { localStorage.removeItem('appSession'); setSession(''); }
    if (!response.ok) throw new Error(result.error || 'Audit request failed.');
    return result;
  }

  async function bootstrap(token = session) {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/audits?action=bootstrap', { headers: { 'x-app-session': token } });
      const result = await response.json();
      if (!response.ok) { if (response.status === 403) setAccessDenied(true); throw new Error(result.error || 'Could not load Conversation Audit.'); }
      setData(result); setSelectedAgents(result.enabledAgentIds?.slice(0, 1) || []); setEnabledDraft(result.enabledAgentIds || []);
      setAccessDraft((result.access?.config?.emails || []).join('\n')); setModelsDraft((result.models || []).join('\n'));
      const active = (result.jobs || []).find((job) => ['queued','running','paused'].includes(job.status));
      if (active) await loadJob(active.id, token);
      checkHealth(token);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  async function checkHealth(token = session) {
    setHealth({ state: 'checking', checkedAt: null, intercom: { detail: 'Checking Intercom…' }, gemini: [], healthyGeminiKeys: 0 });
    try { const result = await request('health', {}, token); setHealth(result.health); }
    catch (err) { setHealth({ state: 'offline', checkedAt: new Date().toISOString(), intercom: { connected: false, detail: err.message }, gemini: [], healthyGeminiKeys: 0 }); }
  }

  async function loadJob(id, token = session) {
    setError('');
    try {
      const response = await fetch(`/api/audits?action=job&id=${encodeURIComponent(id)}`, { headers: { 'x-app-session': token } });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not load this audit.');
      setCurrentJob(result.job); setResults(result.results || []); setView('results');
      if (['queued','running','paused'].includes(result.job.status)) runQueue(result.job.id, token);
    } catch (err) { setError(err.message); }
  }

  async function startAudit() {
    if (!directMode && !selectedAgents.length) return setError('Select at least one agent or enter specific conversation IDs.');
    setError(''); setNotice(''); setRunning(true); stopRef.current = false; setResults([]);
    try {
      const size = customSample ? Number(customSample) : sampleSize;
      const result = await request('create-job', { conversationIds, agentIds: selectedAgents, from, to, sampleSize: size });
      setCurrentJob(result.job); setView('results');
      await runQueue(result.job.id);
      await bootstrap(session);
    } catch (err) { setError(err.message); setRunning(false); }
  }

  async function runQueue(jobId, token = session) {
    if (processingRef.current) return;
    processingRef.current = true;
    setRunning(true); stopRef.current = false;
    try {
      while (!stopRef.current) {
        const result = await request('process-next', { jobId }, token);
        setCurrentJob(result.job);
        if (result.results?.length) setResults((current) => [...current, ...result.results]);
        if (result.processed && result.processed.status !== 'completed') {
          const fresh = await fetch(`/api/audits?action=job&id=${encodeURIComponent(jobId)}`, { headers: { 'x-app-session': token } }).then((response) => response.json());
          if (fresh.results) setResults(fresh.results);
        }
        if (result.job?.status === 'completed' || result.done) break;
        if (result.retryAfterMs) await new Promise((resolve) => setTimeout(resolve, Math.min(result.retryAfterMs, 5000)));
        else await new Promise((resolve) => setTimeout(resolve, 350));
      }
    } catch (err) { setError(err.message); }
    finally { processingRef.current = false; setRunning(false); }
  }

  async function syncAgents() {
    setSyncingAgents(true); setError('');
    try { const result = await request('sync-agents'); setData((current) => ({ ...current, agents: result.agents, enabledAgentIds: result.enabledAgentIds })); setEnabledDraft(result.enabledAgentIds); setNotice(`Intercom connected · ${result.agents.length} agents found.`); }
    catch (err) { setError(err.message); } finally { setSyncingAgents(false); }
  }

  async function saveAdmin(action, payload, success) {
    setSavingAdmin(action); setError('');
    try {
      const result = await request(action, payload); setNotice(success);
      if (result.enabledAgentIds) setData((current) => ({ ...current, enabledAgentIds: result.enabledAgentIds }));
      if (result.access) setData((current) => ({ ...current, access: { ...current.access, config: result.access } }));
      if (result.models) setData((current) => ({ ...current, models: result.models }));
    } catch (err) { setError(err.message); } finally { setSavingAdmin(''); }
  }

  async function download(format, detailed = false) {
    if (!currentJob) return;
    setNotice('Preparing your download…');
    try {
      const response = await fetch(`/api/audits?action=export&jobId=${currentJob.id}&format=${format}${detailed ? '&detailed=1' : ''}`, { headers: headers() });
      if (!response.ok) { const problem = await response.json(); throw new Error(problem.error || 'Download failed.'); }
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `fundednext-audit-${currentJob.id}${detailed ? '-detailed' : ''}.${format}`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`${format.toUpperCase()} report downloaded.`);
    } catch (err) { setError(err.message); }
  }

  if (!session) return <main className="audit-login"><Logo/><h1>Conversation Audit</h1><p>Sign in through the FundedNext Support Assistant, then return here.</p><Link className="btn btn-primary" href="/">Go to sign in</Link></main>;
  if (loading) return <main className="audit-loading"><StatusOrb state="checking"/><h2>Preparing Conversation Audit</h2><p>Checking access, Intercom agents and saved audit history…</p></main>;
  if (accessDenied) return <main className="audit-login"><Logo/><h1>Audit access is restricted</h1><p>{error || 'A Master Admin can grant your @nextventures.io account access from Audit settings.'}</p><Link className="btn btn-primary" href="/">Back to Support Assistant</Link></main>;

  const progress = currentJob?.total ? Math.round((currentJob.processed / currentJob.total) * 100) : 0;
  const avg = (key) => completedResults.length ? (completedResults.reduce((sum, item) => sum + Number(item.audit?.[key] || 0), 0) / completedResults.length).toFixed(2) : '—';

  return <>
    <Head><title>Conversation Audit · FundedNext</title></Head>
    <div className="audit-shell">
      <aside className="audit-sidebar">
        <div className="audit-brand"><Logo/><div><b>FundedNext</b><span>Conversation Audit</span></div></div>
        <nav>
          <button className={view === 'control' ? 'active' : ''} onClick={() => setView('control')}><i>⌁</i><span>Audit control</span></button>
          <button className={view === 'results' ? 'active' : ''} onClick={() => setView('results')}><i>▤</i><span>Results</span>{results.length > 0 && <em>{results.length}</em>}</button>
          <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}><i>◷</i><span>Audit history</span></button>
          {data?.access?.canManage && <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}><i>⚙</i><span>Audit settings</span></button>}
        </nav>
        <div className="sidebar-health"><StatusOrb state={health?.state || 'checking'}/><div><b>{health?.state === 'healthy' ? 'Systems connected' : health?.state === 'degraded' ? 'Fallback available' : health?.state === 'offline' ? 'Connection needed' : 'Checking systems'}</b><small>{health?.healthyGeminiKeys || 0} Gemini keys healthy</small></div></div>
        <div className="audit-side-foot"><Link href="/">← Support assistant</Link>{data?.access?.canManage && <Link href="/admin">Admin console</Link>}</div>
      </aside>

      <main className="audit-main">
        <header className="audit-topbar"><div><span className="eyebrow">Customer Experience Intelligence</span><h1>{view === 'control' ? 'Audit conversations' : view === 'results' ? 'Audit results' : view === 'history' ? 'Audit history' : 'Audit settings'}</h1></div><button className="health-refresh" onClick={() => checkHealth()}><span className={health?.state === 'checking' ? 'spin' : ''}>↻</span> Check connections</button></header>
        {error && <div className="audit-alert error"><b>Action needed</b><span>{error}</span><button onClick={() => setError('')}>×</button></div>}
        {notice && <div className="audit-alert success"><b>Done</b><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}

        {view === 'control' && <div className="audit-control-layout">
          <section className="audit-card connection-card">
            <div className="card-heading"><div><span>Live readiness</span><h2>Connections and capacity</h2><p>Live checks use harmless test requests and never send a customer conversation.</p></div><StatusOrb state={health?.state || 'checking'}/></div>
            <div className="connection-grid">
              <div className={health?.intercom?.connected ? 'connected' : 'disconnected'}><i>{health?.intercom?.connected ? '✓' : '!'}</i><span><b>Intercom</b><small>{health?.intercom?.detail || 'Checking connection…'}</small></span></div>
              <div className={(health?.healthyGeminiKeys || 0) > 0 ? 'connected' : 'disconnected'}><i>{(health?.healthyGeminiKeys || 0) > 0 ? '✓' : '!'}</i><span><b>Gemini pool</b><small>{health?.healthyGeminiKeys || 0} of {health?.gemini?.length ?? data?.connection?.geminiKeyCount ?? 0} keys ready</small></span></div>
              <div className="connected"><i>✓</i><span><b>Knowledge</b><small>Live FAQs, Notices and corrections</small></span></div>
            </div>
          </section>

          <section className={`audit-card direct-card ${directMode ? 'engaged' : ''}`}>
            <div className="card-heading"><div><span>Direct audit</span><h2>Specific conversation IDs</h2><p>Enter one or multiple Intercom conversation IDs separated by commas or new lines.</p></div>{directMode && <b className="override-pill">Override active</b>}</div>
            <textarea value={conversationIds} onChange={(event) => setConversationIds(event.target.value)} placeholder={'129503847, 129503912\n129504021'} rows={4}/>
            {directMode && <div className="override-note"><i>↳</i><span><b>Direct conversation mode</b>Agent, date and random-sample filters below will be ignored.</span></div>}
          </section>

          <div className={`sample-controls ${directMode ? 'disabled' : ''}`} aria-disabled={directMode}>
            <section className="audit-card agent-card">
              <div className="card-heading"><div><span>Step 1</span><h2>Select agents</h2><p>{selectedAgents.length} selected from {enabledAgents.length} enabled agents.</p></div><button onClick={() => setSelectedAgents(selectedAgents.length === enabledAgents.length ? [] : enabledAgents.map((agent) => agent.id))}>{selectedAgents.length === enabledAgents.length ? 'Clear all' : 'Select all'}</button></div>
              <input className="agent-search" value={agentSearch} onChange={(event) => setAgentSearch(event.target.value)} placeholder="Search agents…"/>
              <div className="agent-picker">{visibleAgents.map((agent) => <label key={agent.id} className={selectedAgents.includes(agent.id) ? 'selected' : ''}><input type="checkbox" checked={selectedAgents.includes(agent.id)} onChange={() => setSelectedAgents((current) => current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id])}/><span className="agent-avatar">{agent.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('')}</span><span><b>{agent.name}</b><small>{agent.email || `Intercom ID ${agent.id}`}</small></span><i>✓</i></label>)}</div>
            </section>
            <section className="audit-card sample-card">
              <div className="card-heading"><div><span>Step 2</span><h2>Choose the sample</h2><p>Bot-only chats are excluded before sampling.</p></div></div>
              <div className="date-pair"><label>From<input type="date" value={from} max={to || today()} onChange={(event) => setFrom(event.target.value)}/></label><label>To<input type="date" value={to} min={from} max={today()} onChange={(event) => setTo(event.target.value)}/></label></div>
              <label className="sample-label">Random conversations</label>
              <div className="sample-options">{[10,20,30,40].map((value) => <button key={value} className={!customSample && sampleSize === value ? 'active' : ''} onClick={() => { setSampleSize(value); setCustomSample(''); }}>{value}</button>)}<label className={customSample ? 'active' : ''}><span>Custom</span><input type="number" min="1" max="100" value={customSample} onChange={(event) => setCustomSample(event.target.value)} placeholder="50"/></label></div>
              <div className="sampling-note"><i>⌁</i><span><b>Reproducible random selection</b>The batch stores its sampling seed, selected agents and date boundaries.</span></div>
            </section>
          </div>
          <section className="launch-card"><div><span>Ready when you are</span><h2>{directMode ? `${conversationIds.split(/[\s,]+/).filter(Boolean).length} specific conversation${conversationIds.split(/[\s,]+/).filter(Boolean).length === 1 ? '' : 's'}` : `${customSample || sampleSize} random conversations across ${selectedAgents.length} agent${selectedAgents.length === 1 ? '' : 's'}`}</h2><p>Audits are saved after every conversation and can safely resume after a refresh.</p></div><button className="launch-button" disabled={running || health?.state === 'offline'} onClick={startAudit}><span>{running ? 'Auditing…' : 'Start audit'}</span><i>{running ? '◌' : '→'}</i></button></section>
        </div>}

        {view === 'results' && <div className="audit-results-page">
          {currentJob ? <>
            <section className={`audit-progress-card ${running ? 'running' : ''}`}>
              <div className="progress-visual"><div className="progress-orbit"><i/><i/><b>{currentJob.status === 'completed' ? '✓' : 'QA'}</b></div></div>
              <div className="progress-copy"><span>Batch #{currentJob.id} · {currentJob.mode === 'direct' ? 'Direct conversation audit' : 'Random sample'}</span><h2>{currentJob.stage || 'Preparing audit'}</h2><p>{currentJob.status === 'completed' ? `Completed ${formatDate(currentJob.updatedAt)}` : `${elapsed}s in this session · progress is saved after every conversation`}</p><div className="progress-track"><i style={{ width: `${Math.max(currentJob.processed ? 4 : 0, progress)}%` }}/></div><small>{currentJob.processed} of {currentJob.total} conversations · {progress}%</small></div>
              <div className="progress-actions">{running ? <button onClick={() => { stopRef.current = true; }}>Pause safely</button> : currentJob.status !== 'completed' ? <button onClick={() => runQueue(currentJob.id)}>Resume audit</button> : <button onClick={() => { setView('control'); setCurrentJob(null); setResults([]); }}>New audit</button>}</div>
            </section>
            <div className="audit-kpis"><Metric label="Completed chats" value={currentJob.completed}/><Metric label="Agent evaluations" value={currentJob.evaluations}/><Metric label="Average quality" value={avg('quality')}/><Metric label="Average efficiency" value={avg('efficiency')}/><Metric label="Average final" value={avg('finalScore')} tone="accent"/><Metric label="Manual review" value={completedResults.filter((item) => item.audit?.manualReview).length}/></div>
            <section className="results-toolbar"><div><h2>Conversation evaluations</h2><p>{results.length} saved result{results.length === 1 ? '' : 's'} in this batch.</p></div><div><button onClick={() => download('csv')}>⇩ Summary CSV</button><button onClick={() => download('csv', true)}>⇩ Detailed CSV</button><button className="primary" onClick={() => download('html')}>⇩ HTML report</button></div></section>
            <div className="audit-result-list">{results.map((result) => <ResultCard key={result.id || `${result.conversationId}-${result.agentId}-${result.status}`} result={result}/>)}{!results.length && <div className="empty-results"><StatusOrb state={running ? 'checking' : 'offline'}/><h3>{running ? 'The first conversation is being prepared' : 'No results saved yet'}</h3><p>Live status and the first scored result will appear here automatically.</p></div>}</div>
          </> : <div className="empty-results large"><span>▤</span><h2>No audit selected</h2><p>Start a new audit or open one from Audit history.</p><button onClick={() => setView('control')}>Open audit control</button></div>}
        </div>}

        {view === 'history' && <div className="audit-history"><section className="audit-card"><div className="card-heading"><div><span>Saved securely</span><h2>Recent audit batches</h2><p>Open completed work or resume an interrupted batch.</p></div><button onClick={() => bootstrap()}>Refresh</button></div><div className="history-list">{(data?.jobs || []).map((job) => <button key={job.id} onClick={() => loadJob(job.id)}><span className={`history-state ${job.status}`}>{job.status}</span><span><b>{job.mode === 'direct' ? 'Direct conversation audit' : 'Random agent sample'}</b><small>Batch #{job.id} · {formatDate(job.createdAt)}</small></span><span><b>{job.processed}/{job.total}</b><small>{job.evaluations} evaluations</small></span><i>→</i></button>)}{!data?.jobs?.length && <div className="empty-results"><h3>No audit history yet</h3><p>Your completed and resumable batches will appear here.</p></div>}</div></section></div>}

        {view === 'settings' && data?.access?.canManage && <div className="audit-settings-grid">
          <section className="audit-card"><div className="card-heading"><div><span>Intercom directory</span><h2>Agents in the dropdown</h2><p>Sync the live directory, then choose who can be sampled.</p></div><button disabled={syncingAgents} onClick={syncAgents}>{syncingAgents ? 'Syncing…' : '↻ Sync Intercom'}</button></div><div className="admin-agent-list">{(data.agents || []).map((agent) => <label key={agent.id} className={enabledDraft.includes(agent.id) ? 'enabled' : ''}><input type="checkbox" checked={enabledDraft.includes(agent.id)} onChange={() => setEnabledDraft((current) => current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id])}/><span><b>{agent.name}</b><small>{agent.email || agent.id}</small></span><em>{agent.hasInboxSeat ? 'Inbox seat' : 'No inbox seat'}</em></label>)}</div><button className="settings-save" disabled={savingAdmin === 'save-agents'} onClick={() => saveAdmin('save-agents', { agentIds: enabledDraft }, 'Audit agent dropdown updated.')}>{savingAdmin === 'save-agents' ? 'Saving…' : `Save ${enabledDraft.length} enabled agents`}</button></section>
          <section className="audit-card"><div className="card-heading"><div><span>Restricted access</span><h2>Authorized auditors</h2><p>One verified @nextventures.io email per line. Faiyaz and Master access remain protected.</p></div></div><textarea rows={8} value={accessDraft} onChange={(event) => setAccessDraft(event.target.value)} placeholder="name@nextventures.io"/><button className="settings-save" disabled={savingAdmin === 'save-access'} onClick={() => saveAdmin('save-access', { emails: accessDraft.split(/[\s,]+/).filter(Boolean) }, 'Conversation Audit access updated.')}>{savingAdmin === 'save-access' ? 'Saving…' : 'Save audit access'}</button></section>
          <section className="audit-card"><div className="card-heading"><div><span>Failover order</span><h2>Gemini model chain</h2><p>One stable model ID per line. The next model and key are tried automatically.</p></div></div><textarea className="mono" rows={8} value={modelsDraft} onChange={(event) => setModelsDraft(event.target.value)} placeholder="gemini-3.5-flash-lite"/><button className="settings-save" disabled={savingAdmin === 'save-models'} onClick={() => saveAdmin('save-models', { models: modelsDraft.split(/[\s,]+/).filter(Boolean) }, 'Gemini audit model chain updated.')}>{savingAdmin === 'save-models' ? 'Saving…' : 'Save model chain'}</button></section>
          <section className="audit-card thresholds-card"><div className="card-heading"><div><span>Confirmed scoring targets</span><h2>Efficiency thresholds</h2><p>These values feed deterministic calculations before Gemini reviews the interaction.</p></div></div><div><Metric label="First response" value={`${data.thresholds.frtSeconds}s`} detail="FRT target"/><Metric label="Agent response" value={`${data.thresholds.artSeconds}s`} detail="ART target"/><Metric label="Handling time" value={`${data.thresholds.ahtSeconds / 60}m`} detail="AHT target"/></div></section>
        </div>}
      </main>
    </div>
  </>;
}
