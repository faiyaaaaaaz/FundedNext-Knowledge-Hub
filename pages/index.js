import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';

function inline(s) {
  const parts = String(s).split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    /^\*\*[^*]+\*\*$/.test(p) ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>
  );
}
function renderAnswer(text) {
  const lines = String(text).split('\n');
  const blocks = [];
  let list = [];
  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={'ul' + blocks.length} className="ans-list">
          {list.map((li, i) => <li key={i}>{inline(li)}</li>)}
        </ul>
      );
      list = [];
    }
  };
  lines.forEach((raw) => {
    const line = raw.trim();
    if (!line) { flush(); return; }
    const m = line.match(/^[-*•]\s+(.*)/);
    if (m) { list.push(m[1]); return; }
    flush();
    blocks.push(<p key={'p' + blocks.length} className="ans-p">{inline(line)}</p>);
  });
  flush();
  return blocks;
}

export default function Home() {
  const [pw, setPw] = useState('');
  const [authed, setAuthed] = useState(false);
  const [pwInput, setPwInput] = useState('');

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const threadRef = useRef(null);

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('appPw') : '';
    if (saved) { setPw(saved); setAuthed(true); }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, loading]);

  function fmt(s) { const m = Math.floor(s / 60); const sec = s % 60; return `${m}:${String(sec).padStart(2, '0')}`; }
  function login() { if (!pwInput) return; localStorage.setItem('appPw', pwInput); setPw(pwInput); setAuthed(true); }
  function logout() { localStorage.removeItem('appPw'); setPw(''); setAuthed(false); setPwInput(''); }
  function newChat() { setMessages([]); setError(''); setInput(''); }

  async function send() {
    const q = input.trim();
    if (!q || loading) return;
    setError('');
    setMessages((m) => [...m, { role: 'user', content: q }]);
    setInput('');
    setLoading(true);
    try {
      const r = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': pw },
        body: JSON.stringify({ question: q })
      });
      const j = await r.json();
      if (!r.ok) { if (r.status === 401) logout(); throw new Error(j.error || 'Something went wrong.'); }
      setMessages((m) => [...m, { role: 'bot', content: j.answer, sources: j.sources || [] }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'bot', content: 'Error: ' + e.message, sources: [] }]);
    } finally { setLoading(false); }
  }

  async function checkUpdates() {
    setError(''); setSyncing(true);
    setSyncMsg('Reading your Intercom articles… (first step can take up to a minute)');
    const start = Date.now(); setElapsed(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    try {
      let done = 0, del = 0, pub = 0, guard = 0;
      for (;;) {
        if (++guard > 400) break;
        const r = await fetch('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-app-password': pw },
          body: JSON.stringify({})
        });
        const j = await r.json();
        if (!r.ok) { if (r.status === 401) logout(); throw new Error(j.error || 'Sync failed.'); }
        done += j.processed || 0; del = j.deleted || del; pub = j.totalPublished || pub;
        if (j.done) {
          const parts = [`${done} article${done === 1 ? '' : 's'} updated`];
          if (del) parts.push(`${del} removed`);
          setSyncMsg(`✓ Up to date — ${parts.join(', ')}. ${pub} published in total.`);
          break;
        }
        setSyncMsg(`Building knowledge base… ${done} done, ${j.remaining} to go.`);
      }
    } catch (e) { setSyncMsg('Error: ' + e.message); }
    finally { setSyncing(false); if (timerRef.current) clearInterval(timerRef.current); }
  }

  if (!authed) {
    return (
      <div className="wrap center-screen">
        <div className="login-box card">
          <div className="eyebrow">Knowledge Hub</div>
          <h2 style={{ marginTop: 6, marginBottom: 18 }}>Sign in to continue</h2>
          <input type="password" value={pwInput} placeholder="Password"
            onChange={(e) => setPwInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && login()} />
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={login} style={{ width: '100%' }}>Continue</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap chat-wrap">
      <header className="topbar">
        <div>
          <div className="eyebrow">Knowledge Hub</div>
          <div className="wordmark">Support <span>Assistant</span></div>
        </div>
        <nav className="row">
          <button className="navlink" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={newChat}>New chat</button>
          <Link className="navlink" href="/admin">Admin</Link>
          <button className="navlink" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={logout}>Sign out</button>
        </nav>
      </header>

      <div className="kb-bar">
        <span className="help" style={{ marginTop: 0 }}>Knowledge base synced from Intercom · only changed articles re-processed</span>
        <button className="btn btn-ghost btn-sm" onClick={checkUpdates} disabled={syncing}>
          {syncing ? `Updating… ${fmt(elapsed)}` : 'Check for updates'}
        </button>
      </div>
      {syncMsg && <div className="status-line kb-status">{syncMsg}</div>}

      <div className="chat card">
        <div className="chat-thread" ref={threadRef}>
          {messages.length === 0 && !loading && (
            <div className="empty-state">
              <div className="empty-title">Ask about your FAQs</div>
              <div className="empty-sub">Every answer cites the exact article and link it came from.</div>
            </div>
          )}
          {messages.map((m, i) => (
            m.role === 'user' ? (
              <div className="msg msg-user" key={i}><div className="bubble bubble-user">{m.content}</div></div>
            ) : (
              <div className="msg msg-bot" key={i}>
                <div className="bubble bubble-bot">
                  <div className="answer">{renderAnswer(m.content)}</div>
                  {m.sources && m.sources.length > 0 && (
                    <div className="sources">
                      <h4>Referenced articles</h4>
                      {m.sources.map((s, j) => (
                        <a className="source-item" key={j} href={s.url} target="_blank" rel="noreferrer">
                          <span className="st">{s.title} <span className="arr">↗</span></span>
                          <span className="su">{s.url}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          ))}
          {loading && (
            <div className="msg msg-bot"><div className="bubble bubble-bot typing"><span></span><span></span><span></span></div></div>
          )}
        </div>

        <div className="composer">
          <textarea
            value={input}
            placeholder="Ask a question…  (Enter to send, Shift+Enter for a new line)"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <button className="btn send-btn" onClick={send} disabled={loading || !input.trim()}>Send</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
