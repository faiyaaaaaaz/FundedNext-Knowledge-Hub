import { useState, useEffect } from 'react';
import Link from 'next/link';

export default function Admin() {
  const [pw, setPw] = useState('');
  const [authed, setAuthed] = useState(false);
  const [pwInput, setPwInput] = useState('');

  const [status, setStatus] = useState(null);
  const [intercom, setIntercom] = useState('');
  const [openai, setOpenai] = useState('');
  const [model, setModel] = useState('');

  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('appPw') : '';
    if (saved) { setPw(saved); setAuthed(true); loadStatus(saved); }
  }, []);

  async function loadStatus(p) {
    setError('');
    try {
      const r = await fetch('/api/settings', { headers: { 'x-app-password': p } });
      const j = await r.json();
      if (!r.ok) { if (r.status === 401) logout(); throw new Error(j.error || 'Could not load.'); }
      setStatus(j);
      setModel(j.chatModel || '');
    } catch (e) { setError(e.message); }
  }

  function login() {
    if (!pwInput) return;
    localStorage.setItem('appPw', pwInput);
    setPw(pwInput); setAuthed(true); loadStatus(pwInput);
  }
  function logout() {
    localStorage.removeItem('appPw');
    setPw(''); setAuthed(false); setPwInput(''); setStatus(null);
  }

  async function save() {
    setError(''); setMsg(''); setSaving(true);
    try {
      const body = {};
      if (intercom.trim()) body.intercomToken = intercom.trim();
      if (openai.trim()) body.openaiKey = openai.trim();
      if (model.trim()) body.chatModel = model.trim();
      if (Object.keys(body).length === 0) { setMsg('Nothing to save.'); setSaving(false); return; }
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': pw },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      if (!r.ok) { if (r.status === 401) logout(); throw new Error(j.error || 'Save failed.'); }
      setStatus(j);
      setIntercom(''); setOpenai('');
      setMsg('Saved.');
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  if (!authed) {
    return (
      <div className="wrap center-screen">
        <div className="login-box">
          <div className="eyebrow">Knowledge Hub · Admin</div>
          <h2 style={{ marginTop: 6, marginBottom: 18 }}>Enter password</h2>
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
          <div className="wordmark">API <span>Vault</span></div>
        </div>
        <div className="row">
          <Link className="navlink" href="/">Back to search</Link>
          <button className="navlink" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={logout}>Sign out</button>
        </div>
      </div>

      <div className="card">
        <p className="help" style={{ marginTop: 0 }}>
          Keys are encrypted before storage and are never shown again after saving.
          Leave a field blank to keep the current key. To change a key, paste the new one and save.
        </p>

        <div style={{ marginBottom: 18 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label className="field-label" htmlFor="ic">Intercom API key</label>
            <span className={'pill' + (status && status.intercomSet ? ' set' : '')}>
              {status && status.intercomSet ? 'set ✓' : 'not set'}
            </span>
          </div>
          <input id="ic" type="password" value={intercom} placeholder="Paste to set or replace"
            onChange={(e) => setIntercom(e.target.value)} />
        </div>

        <div style={{ marginBottom: 18 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label className="field-label" htmlFor="oa">OpenAI API key</label>
            <span className={'pill' + (status && status.openaiSet ? ' set' : '')}>
              {status && status.openaiSet ? 'set ✓' : 'not set'}
            </span>
          </div>
          <input id="oa" type="password" value={openai} placeholder="Paste to set or replace"
            onChange={(e) => setOpenai(e.target.value)} />
        </div>

        <div style={{ marginBottom: 18 }}>
          <label className="field-label" htmlFor="md">Answering model</label>
          <input id="md" type="text" value={model} placeholder="gpt-5.6-luna"
            onChange={(e) => setModel(e.target.value)} />
          <p className="help">If you ever get a "model" error when searching, change this (e.g. try <code>gpt-5.6</code> or <code>gpt-5.5</code>) and save.</p>
        </div>

        <div className="row">
          <button className="btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
        {msg && <div className="ok">{msg}</div>}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
