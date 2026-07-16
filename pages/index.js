import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';

// Turn the AI's light markdown into clean React (bold + bullet lists), so
// **word** shows as bold and "- item" shows as a real bullet.
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

  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('appPw') : '';
    if (saved) { setPw(saved); setAuthed(true); }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  function fmt(s) { const m = Math.floor(s / 60); const sec = s % 60; return `${m}:${String(sec).padStart(2, '0')}`; }
  function login() { if (!pwInput) return; localStorage.setItem('appPw', pwInput); setPw(pwInput); setAuthed(true); }
  function logout() { localStorage.removeItem('appPw'); setPw(''); setAuthed(false); setPwInput(''); }

  async function ask() {
    setError(''); setAnswer(null); setSources([]);
    if (!question.trim()) return;
    setLoading(true);
    try {
      const r = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': pw },
        body: JSON.stringify({ question })
      });
      const j = await r.json();
      if (!r.ok) { if (r.status === 401) logout(); throw new Error(j.error || 'Something went wrong.'); }
      setAnswer(j.answer); setSources(j.sources || []);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  async function checkUpdates() {
    setError(''); setSyncing(true);
    setSyncMsg('Reading your Intercom articles… (the first step can take up to a minute)');
    const start = Date.now(); setElapsed(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    try {
      let totalProcessed = 0, totalDeleted = 0, published = 0, guard = 0;
      for (;;) {
        if (++guard > 400) break;
        const r = await fetch('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-app-password': pw },
          body: JSON.stringify({})
        });
        const j = await r.json();
        if (!r.ok) { if (r.status === 401) logout(); throw new Error(j.error || 'Sync failed.'); }
        totalProcessed += j.processed || 0;
        totalDeleted = j.deleted || totalDeleted;
        published = j.totalPublished || published;
        if (j.done) {
          const parts = [`${totalProcessed} article${totalProcessed === 1 ? '' : 's'} updated`];
          if (totalDeleted) parts.push(`${totalDeleted} removed`);
          setSyncMsg(`✓ Up to date — ${parts.join(', ')}. ${published} published articles in total.`);
          break;
        }
        setSyncMsg(`Building knowledge base… ${totalProcessed} done, ${j.remaining} to go.`);
      }
    } catch (e) { setError(e.message); setSyncMsg(''); }
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
    <div className="wrap">
      <header className="topbar">
        <div>
          <div className="eyebrow">Knowledge Hub</div>
          <div className="wordmark">Support <span>Answers</span></div>
        </div>
        <nav className="row">
          <Link className="navlink" href="/admin">Admin</Link>
          <button className="navlink" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={logout}>Sign out</button>
        </nav>
      </header>

      <section className="card">
        <span className="field-label">Knowledge base</span>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <span className="help" style={{ marginTop: 0, maxWidth: '70%' }}>Pull the latest published FAQs from Intercom. Only changed articles are re-processed.</span>
          <button className="btn btn-ghost" onClick={checkUpdates} disabled={syncing}>
            {syncing ? `Working… ${fmt(elapsed)}` : 'Check for updates'}
          </button>
        </div>
        {syncMsg && <div className="status-line">{syncMsg}</div>}
        {syncing && <div className="status-line">Safe to leave this tab open while it runs.</div>}
      </section>

      <section className="card">
        <label className="field-label" htmlFor="q">Ask a question</label>
        <textarea id="q" value={question} placeholder="e.g. How long do withdrawals take?"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask(); }} />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={ask} disabled={loading}>{loading ? 'Searching…' : 'Search knowledge base'}</button>
          <span className="help" style={{ marginTop: 0 }}>Tip: Ctrl/⌘ + Enter to search</span>
        </div>
        {error && <div className="error">{error}</div>}
      </section>

      {answer && (
        <section className="card answer-card">
          <span className="field-label">Answer</span>
          <div className="answer">{renderAnswer(answer)}</div>
          {sources.length > 0 && (
            <div className="sources">
              <h4>Referenced articles</h4>
              {sources.map((s, i) => (
                <a className="source-item" key={i} href={s.url} target="_blank" rel="noreferrer">
                  <span className="st">{s.title} <span className="arr">↗</span></span>
                  <span className="su">{s.url}</span>
                </a>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
