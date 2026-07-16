import { useState, useEffect } from 'react';
import Link from 'next/link';

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

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('appPw') : '';
    if (saved) { setPw(saved); setAuthed(true); }
  }, []);

  function login() {
    if (!pwInput) return;
    localStorage.setItem('appPw', pwInput);
    setPw(pwInput);
    setAuthed(true);
  }
  function logout() {
    localStorage.removeItem('appPw');
    setPw(''); setAuthed(false); setPwInput('');
  }

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
      setAnswer(j.answer);
      setSources(j.sources || []);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  async function checkUpdates() {
    setError(''); setSyncing(true); setSyncMsg('Checking Intercom for changes…');
    try {
      let totalProcessed = 0;
      let totalDeleted = 0;
      let published = 0;
      let guard = 0;
      // Keep calling until the server says it's finished.
      for (;;) {
        if (++guard > 300) break;
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
          setSyncMsg(`Up to date — ${parts.join(', ')}. ${published} published articles in total.`);
          break;
        }
        setSyncMsg(`Updating… ${totalProcessed} done, ${j.remaining} to go.`);
      }
    } catch (e) { setError(e.message); setSyncMsg(''); } finally { setSyncing(false); }
  }

  if (!authed) {
    return (
      <div className="wrap center-screen">
        <div className="login-box">
          <div className="eyebrow">Knowledge Hub</div>
          <h2 style={{ marginTop: 6, marginBottom: 18 }}>Enter password to continue</h2>
          <input
            type="password"
            value={pwInput}
            placeholder="Password"
            onChange={(e) => setPwInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && login()}
          />
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={login} style={{ width: '100%' }}>Continue</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="topbar">
        <div>
          <div className="eyebrow">Knowledge Hub</div>
          <div className="wordmark">Support <span>Answers</span></div>
        </div>
        <div className="row">
          <Link className="navlink" href="/admin">Admin</Link>
          <button className="navlink" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={logout}>Sign out</button>
        </div>
      </div>

      <div className="card">
        <span className="field-label">Knowledge base</span>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="help" style={{ marginTop: 0 }}>Pull the latest published FAQs from Intercom. Only changed articles are re-processed.</span>
          <button className="btn btn-ghost" onClick={checkUpdates} disabled={syncing}>
            {syncing ? 'Working…' : 'Check for updates'}
          </button>
        </div>
        {syncMsg && <div className="status-line">{syncMsg}</div>}
      </div>

      <div className="card">
        <label className="field-label" htmlFor="q">Ask a question</label>
        <textarea
          id="q"
          value={question}
          placeholder="e.g. How long do withdrawals take?"
          onChange={(e) => setQuestion(e.target.value)}
        />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={ask} disabled={loading}>{loading ? 'Searching…' : 'Search knowledge base'}</button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>

      {answer && (
        <div className="card">
          <span className="field-label">Answer</span>
          <div className="answer">{answer}</div>
          {sources.length > 0 && (
            <div className="sources">
              <h4>Referenced articles</h4>
              {sources.map((s, i) => (
                <a className="source-item" key={i} href={s.url} target="_blank" rel="noreferrer">
                  <span className="st">{s.title}</span><br />
                  <span className="su">{s.url}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
