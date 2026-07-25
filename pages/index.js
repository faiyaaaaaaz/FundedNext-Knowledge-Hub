import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getSupabaseBrowser } from '../lib/supabaseBrowser';

const THINKING_STEPS = ['Understanding your question', 'Searching the most relevant FAQs', 'Checking Account-specific rules', 'Applying Brand Language', 'Verifying sources and confidence', 'Preparing a client-ready answer'];

function Brand() {
  return <div className="brand"><img src="/favicon.svg" alt="" /><div><b>FundedNext</b><span>Support Assistant</span></div></div>;
}

function inline(text) {
  return String(text).split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    /^\*\*[^*]+\*\*$/.test(part) ? <strong key={index}>{part.slice(2, -2)}</strong> : <span key={index}>{part}</span>
  );
}

function Answer({ text }) {
  const blocks = [];
  let list = [];
  let listType = '';
  const flush = () => {
    if (!list.length) return;
    const Tag = listType === 'number' ? 'ol' : 'ul';
    blocks.push(<Tag key={`list-${blocks.length}`}>{list.map((item, index) => <li key={index}>{inline(item)}</li>)}</Tag>);
    list = []; listType = '';
  };
  String(text).split('\n').forEach((raw) => {
    const line = raw.trim();
    if (!line) return flush();
    const bullet = line.match(/^[-*•]\s+(.*)/);
    const numbered = line.match(/^\d+[.)]\s+(.*)/);
    if (bullet || numbered) {
      const type = numbered ? 'number' : 'bullet';
      if (listType && listType !== type) flush();
      listType = type; list.push((bullet || numbered)[1]); return;
    }
    flush();
    if (/^#{1,3}\s+/.test(line)) blocks.push(<h3 key={`h-${blocks.length}`}>{inline(line.replace(/^#{1,3}\s+/, ''))}</h3>);
    else blocks.push(<p key={`p-${blocks.length}`}>{inline(line)}</p>);
  });
  flush();
  return <div className="answer">{blocks}</div>;
}

function formatDhaka(value) {
  if (!value) return 'Not available';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  }).format(new Date(value)) + ' GMT+6';
}

function confidenceTone(score) {
  if (score >= 85) return 'high';
  if (score >= 65) return 'medium';
  return 'low';
}

export default function Home() {
  const [session, setSession] = useState('');
  const [role, setRole] = useState('');
  const [identity, setIdentity] = useState({ name: '', email: '' });
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [theme, setTheme] = useState('light');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [thinkingStep, setThinkingStep] = useState(0);
  const [openSources, setOpenSources] = useState({});
  const [copied, setCopied] = useState(null);
  const [stats, setStats] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncState, setSyncState] = useState({ headline: 'Published Intercom articles', details: [] });
  const [elapsed, setElapsed] = useState(0);
  const [disputeIndex, setDisputeIndex] = useState(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeError, setDisputeError] = useState('');
  const [submittingDispute, setSubmittingDispute] = useState(false);
  const threadRef = useRef(null);
  const timerRef = useRef(null);
  const cancelRef = useRef(false);
  const abortRef = useRef(null);
  const thinkingRef = useRef(null);

  useEffect(() => {
    const savedSession = localStorage.getItem('appSession') || '';
    const savedRole = localStorage.getItem('appRole') || '';
    if (savedSession) {
      setSession(savedSession); setRole(savedRole);
      setIdentity({ name: localStorage.getItem('appName') || '', email: localStorage.getItem('appEmail') || '' });
      loadStats(savedSession);
    } else completeGoogleLogin();
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme); document.documentElement.setAttribute('data-theme', savedTheme);
    return () => { timerRef.current && clearInterval(timerRef.current); thinkingRef.current && clearInterval(thinkingRef.current); };
  }, []);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, loading]);

  function headers(token = session, json = false) {
    return { ...(json ? { 'Content-Type': 'application/json' } : {}), 'x-app-session': token };
  }

  async function loadStats(token = session) {
    if (!token) return;
    try {
      const response = await fetch('/api/stats', { headers: { 'x-app-session': token } });
      if (response.ok) setStats(await response.json());
    } catch {}
  }

  async function login() {
    if (!password || loggingIn) return;
    setLoggingIn(true); setLoginError('');
    try {
      const response = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not sign in.');
      storeLogin(data); setPassword('');
    } catch (error) { setLoginError(error.message); } finally { setLoggingIn(false); }
  }

  function storeLogin(data) {
    localStorage.setItem('appSession', data.token); localStorage.setItem('appRole', data.role);
    localStorage.setItem('appName', data.name || ''); localStorage.setItem('appEmail', data.email || '');
    setSession(data.token); setRole(data.role); setIdentity({ name: data.name || '', email: data.email || '' });
    loadStats(data.token);
  }

  async function completeGoogleLogin() {
    const client = getSupabaseBrowser();
    if (!client) return;
    setLoggingIn(true);
    try {
      const { data } = await client.auth.getSession();
      if (!data.session?.access_token) return;
      const response = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ googleAccessToken: data.session.access_token }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Google sign-in was not accepted.');
      storeLogin(result);
    } catch (error) { setLoginError(error.message); } finally { setLoggingIn(false); }
  }

  async function googleLogin() {
    const client = getSupabaseBrowser();
    if (!client) return setLoginError('Google sign-in is not configured yet. Please ask an Admin to finish setup.');
    setLoginError('');
    const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
    if (error) setLoginError(error.message);
  }

  function logout() {
    localStorage.removeItem('appSession'); localStorage.removeItem('appRole'); localStorage.removeItem('appPw');
    localStorage.removeItem('appName'); localStorage.removeItem('appEmail');
    getSupabaseBrowser()?.auth.signOut().catch(() => {});
    setSession(''); setRole(''); setIdentity({ name: '', email: '' }); setMessages([]); setStats(null);
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next); localStorage.setItem('theme', next); document.documentElement.setAttribute('data-theme', next);
  }

  async function send(question = input.trim()) {
    const value = String(question).trim();
    if (!value || loading) return;
    const questionId = `${Date.now()}-${Math.random()}`;
    setMessages((current) => [...current, { role: 'user', content: value, questionId }]);
    setInput(''); setLoading(true); setThinkingStep(0);
    thinkingRef.current = setInterval(() => setThinkingStep((current) => Math.min(current + 1, THINKING_STEPS.length - 1)), 1300);
    try {
      const response = await fetch('/api/search', { method: 'POST', headers: headers(session, true), body: JSON.stringify({ question: value }) });
      const data = await response.json();
      if (response.status === 401) { logout(); throw new Error('Your session ended. Please sign in again.'); }
      if (!response.ok) throw new Error(data.error || 'The assistant could not answer.');
      setMessages((current) => [...current, {
        role: 'assistant', question: value, questionId, content: data.answer,
        sources: data.sources || [], provider: data.answerProvider, fallback: data.usedFallback,
        confidence: data.confidence, confidenceLabel: data.confidenceLabel, disputed: false
      }]);
    } catch (error) {
      setMessages((current) => [...current, { role: 'assistant', question: value, questionId, content: error.message, sources: [], error: true }]);
    } finally { clearInterval(thinkingRef.current); setLoading(false); loadStats(); }
  }

  async function copyAnswer(index, text) {
    await navigator.clipboard.writeText(text);
    setCopied(index); setTimeout(() => setCopied(null), 1800);
  }

  async function submitDispute() {
    const message = messages[disputeIndex];
    if (!message) return;
    if (disputeReason.trim().length < 10) return setDisputeError('Please explain what is wrong in at least 10 characters.');
    setSubmittingDispute(true); setDisputeError('');
    try {
      const response = await fetch('/api/disputes', {
        method: 'POST', headers: headers(session, true),
        body: JSON.stringify({
          question: message.question, answer: message.content, reason: disputeReason.trim(),
          confidence: message.confidence, provider: message.provider, sources: message.sources
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not submit the dispute.');
      setMessages((current) => current.map((item, index) =>
        index === disputeIndex ? { ...item, disputed: true, disputeId: data.dispute.id } : item
      ));
      setDisputeIndex(null); setDisputeReason('');
    } catch (error) { setDisputeError(error.message); } finally { setSubmittingDispute(false); }
  }

  async function checkUpdates() {
    setSyncing(true); setSyncOpen(true); cancelRef.current = false; setElapsed(0);
    const started = Date.now();
    let processed = 0, chunks = 0, batches = 0, failures = 0;
    setSyncState({ headline: 'Starting knowledge update…', details: ['Connecting to the update queue'] });
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    try {
      for (;;) {
        if (cancelRef.current) {
          setSyncState((current) => ({ ...current, headline: 'Update paused safely', details: [...current.details, 'Completed progress has been saved'] }));
          break;
        }
        const controller = new AbortController(); abortRef.current = controller;
        const timeout = setTimeout(() => controller.abort(), 90000);
        try {
          const response = await fetch('/api/sync', { method: 'POST', headers: headers(session, true), body: '{}', signal: controller.signal });
          clearTimeout(timeout);
          const data = await response.json();
          if (response.status === 401) { logout(); break; }
          if (!response.ok) throw new Error(data.error || `Server ${response.status}`);
          failures = 0; processed += data.processed || 0; chunks += data.chunkCount || 0; batches += data.embeddingBatches || 0;
          const detail = data.phase === 'detecting'
            ? [`Scanned ${data.scanned || 0} published articles`, `Found ${data.changedFound || 0} new or changed articles`, `Deletion safety check: ${data.deletionGuard || 'complete'}`]
            : [`Processed ${processed} articles`, `Created ${chunks} searchable sections`, `Completed ${batches} embedding batches`, ...(data.sampleTitles?.length ? [`Current batch: ${data.sampleTitles.join(' · ')}`] : [])];
          setSyncState({ headline: data.done ? 'Knowledge is fully up to date' : data.phase === 'detecting' ? 'Comparing Intercom with stored knowledge' : `${data.remaining} articles remaining`, details: detail });
          if (data.done) break;
        } catch {
          clearTimeout(timeout); if (cancelRef.current) continue;
          failures++;
          if (failures > 8) { setSyncState({ headline: 'Update paused after connection problems', details: ['Your completed progress is safe', 'Press Check for updates to resume'] }); break; }
          setSyncState((current) => ({ headline: `Reconnecting automatically · attempt ${failures}/8`, details: current.details }));
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
      }
    } finally {
      clearInterval(timerRef.current); setSyncing(false); loadStats();
    }
  }

  if (!session) return (
    <main className="login-page"><section className="login-panel"><div className="login-glow" /><Brand />
      <div className="login-copy"><span className="status-chip">Internal knowledge workspace</span><h1>Answers your team can trust.</h1><p>Find clear, source-backed support answers for FundedNext clients.</p></div>
      <div className="login-form"><button className="google-button" onClick={googleLogin} disabled={loggingIn}><span className="google-mark">G</span>{loggingIn ? 'Finishing sign-in…' : 'Continue with Google'}</button><div className="login-divider"><span>Admin access</span></div><label htmlFor="password">Master password</label><input id="password" type="password" value={password} placeholder="Enter the Admin password" onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && login()} /><button className="btn btn-primary" onClick={login} disabled={loggingIn}>{loggingIn ? 'Signing in…' : 'Continue securely'} <span>→</span></button>{loginError && <div className="inline-error">{loginError}</div>}</div>
      <div className="login-foot">For authorized FundedNext team members only</div>
    </section></main>
  );

  return (
    <main className="app-shell">
      <header className="app-header"><Brand /><div className="header-actions">{identity.name && <div className="user-identity"><b>{identity.name}</b><small>{identity.email}</small></div>}<span className="role-badge">{role}</span><button className="icon-btn" onClick={toggleTheme} title="Change theme">{theme === 'dark' ? '☀' : '◐'}</button>{role === 'admin' && <Link className="btn btn-secondary btn-small" href="/admin">Admin console</Link>}<button className="icon-btn" onClick={logout} title="Sign out">↪</button></div></header>

      {role === 'admin' && <div className={`sync-console ${syncOpen ? 'expanded' : ''}`}><div className="sync-summary"><div><span className={`live-dot ${syncing ? 'working' : ''}`} /><b>{syncState.headline}</b><span>{syncing ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} elapsed` : 'Published Intercom articles'}</span></div><div className="row"><button className="text-button neutral" onClick={() => setSyncOpen(!syncOpen)}>{syncOpen ? 'Hide details' : 'View details'}</button><button className="btn btn-secondary btn-small" onClick={checkUpdates} disabled={syncing}>{syncing ? 'Updating…' : 'Check for updates'}</button>{syncing && <button className="text-button" onClick={() => { cancelRef.current = true; abortRef.current?.abort(); }}>Cancel</button>}</div></div>{syncOpen && <div className="sync-details">{syncState.details.map((detail, index) => <div key={index}><span>{index + 1}</span>{detail}</div>)}</div>}</div>}

      <div className="workspace-grid">
        <section className="assistant-card">
          <div className="chat-thread" ref={threadRef}>
            {!messages.length && <div className="welcome-state"><div className="assistant-orb"><img src="/favicon.svg" alt="" /></div><span className="status-chip">Source-backed assistance</span><h1>How can I help today?</h1><p>Ask about a policy, Account, Performance Reward, trading rule, or platform.</p><div className="suggestion-grid">{['How does trailing drawdown work?', 'Explain Performance Reward eligibility', 'What causes an Account breach?'].map((question) => <button key={question} onClick={() => send(question)}>{question}<span>↗</span></button>)}</div></div>}
            {messages.map((message, index) => message.role === 'user'
              ? <div className="message user-message" key={index}><div className="message-label">You</div><div className="user-bubble">{message.content}</div></div>
              : <div className="message assistant-message" key={index}><div className="bot-avatar"><img src="/favicon.svg" alt="" /></div><div className={`assistant-bubble${message.error ? ' error-bubble' : ''}`}><div className="answer-head"><span>FundedNext Assistant</span><div>{Number.isFinite(message.confidence) && <span className={`confidence-pill ${confidenceTone(message.confidence)}`}><i style={{ '--score': `${message.confidence * 3.6}deg` }} />{message.confidence}% · {message.confidenceLabel}</span>}<small>{message.fallback ? 'OpenAI backup' : message.provider === 'groq' ? 'Groq' : 'OpenAI'}</small></div></div><Answer text={message.content} /><div className="answer-actions"><button onClick={() => copyAnswer(index, message.content)}>{copied === index ? '✓ Copied' : '⧉ Copy answer'}</button><button className={message.disputed ? 'disputed' : ''} disabled={message.disputed || message.error} onClick={() => { setDisputeIndex(index); setDisputeReason(''); setDisputeError(''); }}>{message.disputed ? '✓ Answer disputed' : '⚑ Dispute answer'}</button></div>{message.sources?.length > 0 && <div className="sources"><button className="sources-toggle" onClick={() => setOpenSources((current) => ({ ...current, [index]: !current[index] }))}><span>◆</span>{message.sources.length} verified source{message.sources.length > 1 ? 's' : ''}<b>{openSources[index] ? '−' : '+'}</b></button>{openSources[index] && <div className="sources-list">{message.sources.map((source, sourceIndex) => <a key={sourceIndex} href={source.url} target="_blank" rel="noreferrer"><span>{source.title}</span><small>Open article ↗</small></a>)}</div>}</div>}</div></div>
            )}
            {loading && <div className="message assistant-message"><div className="bot-avatar thinking-avatar"><img src="/favicon.svg" alt="" /></div><div className="assistant-bubble thinking-card"><div className="thinking-visual"><i /><i /><i /><span>✦</span></div><div className="thinking-copy"><b>Working on your answer</b><p>{THINKING_STEPS[thinkingStep]}</p><div className="thinking-progress">{THINKING_STEPS.map((step, index) => <i key={step} className={index <= thinkingStep ? 'active' : ''} />)}</div></div></div></div>}
          </div>
          <div className="composer-wrap"><div className="composer"><textarea value={input} placeholder="Ask a support question…" onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} /><button onClick={() => send()} disabled={!input.trim() || loading} aria-label="Send">↑</button></div><div className="composer-note">Review the confidence and verified source before sending the answer.</div></div>
        </section>

        <aside className="insights-rail"><div className="rail-head"><span className="live-dot" /><div><b>Knowledge health</b><small>{stats?.healthy ? 'All systems operational' : 'Checking status…'}</small></div></div><div className="metric-card model-card"><span>Answering model</span><strong>{stats?.answerProvider === 'groq' ? 'Groq' : 'OpenAI'}</strong><small>{stats?.answerModel || 'Checking model…'}</small><em>Automatic fallback is off</em></div><div className="metric-card primary"><span>Published articles</span><strong>{stats?.totalArticles?.toLocaleString() ?? '—'}</strong><small>Total articles stored and available</small></div><div className="metric-grid"><div className="metric-card"><span>Indexed</span><strong>{stats?.indexedArticles?.toLocaleString() ?? '—'}</strong></div><div className="metric-card"><span>Queued</span><strong>{stats?.queuedArticles?.toLocaleString() ?? '—'}</strong></div></div><div className="metric-card"><span>Searchable sections</span><strong>{stats?.totalChunks?.toLocaleString() ?? '—'}</strong><small>Focused pieces used for retrieval</small></div><div className="metric-card update-time"><span>Last knowledge update</span><strong>{formatDhaka(stats?.lastUpdatedAt)}</strong></div>{role === 'admin' && <div className="metric-card dispute-metric"><span>Pending disputes</span><strong>{stats?.pendingDisputes ?? '—'}</strong><Link href="/admin">Review in Admin →</Link></div>}<div className="rail-tip"><b>Confidence guide</b><p><span className="dot high" />85–100: strong direct support</p><p><span className="dot medium" />65–84: review suggested</p><p><span className="dot low" />Below 65: verify carefully</p></div></aside>
      </div>

      {disputeIndex !== null && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setDisputeIndex(null)}><div className="modal-card"><div className="modal-icon">⚑</div><h2>Dispute this answer?</h2><p>Explain exactly what appears incorrect or incomplete. Your reason is required and will be reviewed by an Admin.</p><label htmlFor="dispute-reason">Reason for dispute</label><textarea id="dispute-reason" value={disputeReason} onChange={(event) => setDisputeReason(event.target.value)} placeholder="Example: The Performance Reward cycle is outdated for the Stellar Instant Account…" autoFocus />{disputeError && <div className="inline-error">{disputeError}</div>}<div className="modal-actions"><button className="btn btn-secondary" onClick={() => setDisputeIndex(null)}>Cancel</button><button className="btn btn-danger" onClick={submitDispute} disabled={submittingDispute}>{submittingDispute ? 'Submitting…' : 'Submit dispute'}</button></div></div></div>}
    </main>
  );
}
