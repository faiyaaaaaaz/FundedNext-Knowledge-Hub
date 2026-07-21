import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

function Brand({ compact = false }) {
  return <div className="brand"><img src="/favicon.svg" alt="" /><div><b>FundedNext</b>{!compact && <span>Support Assistant</span>}</div></div>;
}

function inline(text) {
  return String(text).split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    /^\*\*[^*]+\*\*$/.test(part) ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>
  );
}

function Answer({ text }) {
  const blocks = [];
  let items = [];
  const flush = () => {
    if (items.length) blocks.push(<ul key={`l${blocks.length}`}>{items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>);
    items = [];
  };
  String(text).split('\n').forEach((raw) => {
    const line = raw.trim();
    if (!line) return flush();
    const match = line.match(/^[-*•]\s+(.*)/);
    if (match) return items.push(match[1]);
    flush(); blocks.push(<p key={`p${blocks.length}`}>{inline(line)}</p>);
  });
  flush();
  return <div className="answer">{blocks}</div>;
}

export default function Home() {
  const [session, setSession] = useState('');
  const [role, setRole] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [theme, setTheme] = useState('light');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [openSources, setOpenSources] = useState({});
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const threadRef = useRef(null);
  const timerRef = useRef(null);
  const cancelRef = useRef(false);
  const abortRef = useRef(null);

  useEffect(() => {
    const savedSession = localStorage.getItem('appSession') || '';
    const savedRole = localStorage.getItem('appRole') || '';
    if (savedSession) { setSession(savedSession); setRole(savedRole); }
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme); document.documentElement.setAttribute('data-theme', savedTheme);
    return () => timerRef.current && clearInterval(timerRef.current);
  }, []);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, loading]);

  function authHeaders(json = false) {
    return { ...(json ? { 'Content-Type': 'application/json' } : {}), 'x-app-session': session };
  }

  async function login() {
    if (!password || loggingIn) return;
    setLoggingIn(true); setLoginError('');
    try {
      const response = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not sign in.');
      localStorage.setItem('appSession', data.token); localStorage.setItem('appRole', data.role);
      setSession(data.token); setRole(data.role); setPassword('');
    } catch (e) { setLoginError(e.message); } finally { setLoggingIn(false); }
  }

  function logout() {
    localStorage.removeItem('appSession'); localStorage.removeItem('appRole'); localStorage.removeItem('appPw');
    setSession(''); setRole(''); setPassword(''); setMessages([]); setSyncMessage('');
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next); localStorage.setItem('theme', next); document.documentElement.setAttribute('data-theme', next);
  }

  async function send(question = input.trim()) {
    const q = String(question).trim();
    if (!q || loading) return;
    setMessages((current) => [...current, { role: 'user', content: q }]); setInput(''); setLoading(true);
    try {
      const response = await fetch('/api/search', { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ question: q }) });
      const data = await response.json();
      if (response.status === 401) { logout(); throw new Error('Your session ended. Please sign in again.'); }
      if (!response.ok) throw new Error(data.error || 'The assistant could not answer.');
      setMessages((current) => [...current, { role: 'assistant', content: data.answer, sources: data.sources || [], provider: data.answerProvider, fallback: data.usedFallback }]);
    } catch (e) {
      setMessages((current) => [...current, { role: 'assistant', content: `I couldn't complete that request. ${e.message}`, sources: [], error: true }]);
    } finally { setLoading(false); }
  }

  async function checkUpdates() {
    setSyncing(true); setSyncMessage('Scanning published Intercom articles…'); cancelRef.current = false;
    const started = Date.now(); setElapsed(0);
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    let processed = 0, failures = 0;
    try {
      for (;;) {
        if (cancelRef.current) { setSyncMessage(`Paused. ${processed} articles completed and progress was saved.`); break; }
        const controller = new AbortController(); abortRef.current = controller;
        const timeout = setTimeout(() => controller.abort(), 90000);
        try {
          const response = await fetch('/api/sync', { method: 'POST', headers: authHeaders(true), body: '{}', signal: controller.signal });
          clearTimeout(timeout);
          const data = await response.json();
          if (response.status === 401) { logout(); break; }
          if (!response.ok) throw new Error(data.error || `Server ${response.status}`);
          failures = 0; processed += data.processed || 0;
          if (data.done) { setSyncMessage(`Knowledge base is current · ${data.totalPublished || 'All'} published articles checked`); break; }
          setSyncMessage(data.phase === 'detecting' ? `Found ${data.remaining} changed articles. Preparing updates…` : `Updating knowledge · ${processed} completed · ${data.remaining} remaining`);
        } catch (e) {
          clearTimeout(timeout); if (cancelRef.current) continue;
          if (++failures > 8) { setSyncMessage('Update paused after repeated connection problems. You can safely resume later.'); break; }
          setSyncMessage(`Connection interrupted. Retrying automatically (${failures}/8)…`);
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
      }
    } finally { clearInterval(timerRef.current); setSyncing(false); }
  }

  if (!session) return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-glow" />
        <Brand />
        <div className="login-copy"><span className="status-chip">Internal knowledge workspace</span><h1>Answers your team can trust.</h1><p>Search FundedNext’s published knowledge and respond with confidence—complete with the exact source.</p></div>
        <div className="login-form">
          <label htmlFor="password">Workspace password</label>
          <input id="password" type="password" value={password} placeholder="Enter your password" autoFocus onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && login()} />
          <button className="btn btn-primary" onClick={login} disabled={loggingIn}>{loggingIn ? 'Signing in…' : 'Continue securely'} <span>→</span></button>
          {loginError && <div className="inline-error">{loginError}</div>}
        </div>
        <div className="login-foot">For authorized FundedNext team members only</div>
      </section>
    </main>
  );

  return (
    <main className="app-shell">
      <header className="app-header">
        <Brand />
        <div className="header-actions">
          <span className="role-badge">{role === 'admin' ? 'Admin' : 'Agent'}</span>
          <button className="icon-btn" onClick={toggleTheme} title="Change theme">{theme === 'dark' ? '☀' : '◐'}</button>
          {role === 'admin' && <Link className="btn btn-secondary btn-small" href="/admin">Admin console</Link>}
          <button className="icon-btn" onClick={logout} title="Sign out">↪</button>
        </div>
      </header>

      {role === 'admin' && <div className="admin-strip"><div><span className="live-dot" /> <b>Knowledge base</b><span>{syncMessage || 'Published Intercom articles'}</span></div><div className="row"><button className="btn btn-secondary btn-small" onClick={checkUpdates} disabled={syncing}>{syncing ? `Updating · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` : 'Check for updates'}</button>{syncing && <button className="text-button" onClick={() => { cancelRef.current = true; abortRef.current?.abort(); }}>Cancel</button>}</div></div>}

      <section className="assistant-card">
        <div className="chat-thread" ref={threadRef}>
          {!messages.length && <div className="welcome-state"><div className="assistant-orb"><img src="/favicon.svg" alt="" /></div><span className="status-chip">Grounded in published articles</span><h1>How can I help today?</h1><p>Ask a policy, program, payout, trading-rule, or platform question. Every answer includes its source.</p><div className="suggestion-grid">{['How does trailing drawdown work?', 'Explain payout eligibility', 'What causes an account breach?'].map((q) => <button key={q} onClick={() => send(q)}>{q}<span>↗</span></button>)}</div></div>}
          {messages.map((message, index) => message.role === 'user' ?
            <div className="message user-message" key={index}><div className="message-label">You</div><div className="user-bubble">{message.content}</div></div> :
            <div className="message assistant-message" key={index}><div className="bot-avatar"><img src="/favicon.svg" alt="" /></div><div className={`assistant-bubble${message.error ? ' error-bubble' : ''}`}><div className="answer-head"><span>FundedNext Assistant</span>{message.provider && <small>{message.fallback ? 'OpenAI backup' : message.provider === 'groq' ? 'Groq' : 'OpenAI'}</small>}</div><Answer text={message.content} />{message.sources?.length > 0 && <div className="sources"><button className="sources-toggle" onClick={() => setOpenSources((current) => ({ ...current, [index]: !current[index] }))}><span>◆</span> {message.sources.length} verified source{message.sources.length > 1 ? 's' : ''}<b>{openSources[index] ? '−' : '+'}</b></button>{openSources[index] && <div className="sources-list">{message.sources.map((source, i) => <a key={i} href={source.url} target="_blank" rel="noreferrer"><span>{source.title}</span><small>Open article ↗</small></a>)}</div>}</div>}</div></div>)}
          {loading && <div className="message assistant-message"><div className="bot-avatar"><img src="/favicon.svg" alt="" /></div><div className="assistant-bubble typing"><span /><span /><span /></div></div>}
        </div>
        <div className="composer-wrap"><div className="composer"><textarea value={input} placeholder="Ask the knowledge base…" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} /><button onClick={() => send()} disabled={!input.trim() || loading} aria-label="Send">↑</button></div><div className="composer-note">Answers are generated from published FundedNext knowledge. Verify the cited source before sending.</div></div>
      </section>
    </main>
  );
}
