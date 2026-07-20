import { useState, useEffect } from 'react';
import Link from 'next/link';

const MODEL_OPTIONS = [
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna (fast, low cost)' },
  { id: 'gpt-5.6', label: 'GPT-5.6 (strongest)' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  { id: 'gpt-4o', label: 'GPT-4o' }
];
const CUSTOM = '__custom__';

export default function Admin() {
  const [pw, setPw] = useState('');
  const [authed, setAuthed] = useState(false);
  const [pwInput, setPwInput] = useState('');

  const [status, setStatus] = useState(null);
  const [intercom, setIntercom] = useState('');
  const [openai, setOpenai] = useState('');

  const [selectedModel, setSelectedModel] = useState('gpt-5.6-luna');
  const [customModel, setCustomModel] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);

  const [prompt, setPrompt] = useState('');

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
      const current = j.chatModel || 'gpt-5.6-luna';
      if (MODEL_OPTIONS.some((m) => m.id === current)) setSelectedModel(current);
      else { setSelectedModel(CUSTOM); setCustomModel(current); }
      setPrompt(j.chatPrompt || '');
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
      if (makeDefault) {
        const chosen = selectedModel === CUSTOM ? customModel.trim() : selectedModel;
        if (chosen) body.chatModel = chosen;
      }
      body.chatPrompt = prompt;

      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': pw },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      if (!r.ok) { if (r.status === 401) logout(); throw new Error(j.error || 'Save failed.'); }
      setStatus(j);
      setIntercom(''); setOpenai(''); setMakeDefault(false);
      setPrompt(j.chatPrompt || '');
      setMsg('Saved.');
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  if (!authed) {
    return (
      <div className="wrap center-screen">
        <div className="login-box card">
          <div className="eyebrow">Knowledge Hub · Admin</div>
          <h2 style={{ marginTop: 6, marginBottom: 18 }}>Enter password</h2>
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
          <div className="wordmark">API <span>Vault</span></div>
        </div>
        <nav className="row">
          <Link className="navlink" href="/">Back to chat</Link>
          <button className="navlink" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={logout}>Sign out</button>
        </nav>
      </header>

      <section className="card">
        <p className="help" style={{ marginTop: 0 }}>
          Keys are encrypted before storage and never shown again. Leave a field blank to keep the current key.
        </p>

        <div style={{ marginBottom: 18 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label className="field-label" htmlFor="ic">Intercom API key</label>
            <span className={'pill' + (status && status.intercomSet ? ' set' : '')}>{status && status.intercomSet ? 'set ✓' : 'not set'}</span>
          </div>
          <input id="ic" type="password" value={intercom} placeholder="Paste to set or replace" onChange={(e) => setIntercom(e.target.value)} />
        </div>

        <div style={{ marginBottom: 18 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label className="field-label" htmlFor="oa">OpenAI API key</label>
            <span className={'pill' + (status && status.openaiSet ? ' set' : '')}>{status && status.openaiSet ? 'set ✓' : 'not set'}</span>
          </div>
          <input id="oa" type="password" value={openai} placeholder="Paste to set or replace" onChange={(e) => setOpenai(e.target.value)} />
        </div>

        <div style={{ marginBottom: 18 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label className="field-label" htmlFor="md">Answering model</label>
            <span className="pill">default: {status ? status.chatModel : '—'}</span>
          </div>
          <select id="md" value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}
            style={{ width: '100%', padding: '13px 14px', border: '1px solid var(--line)', borderRadius: 10, fontSize: 15, background: 'var(--input-bg)', color: 'var(--ink)' }}>
            {MODEL_OPTIONS.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
            <option value={CUSTOM}>Custom…</option>
          </select>
          {selectedModel === CUSTOM && (
            <input type="text" value={customModel} placeholder="Exact model id, e.g. gpt-4"
              onChange={(e) => setCustomModel(e.target.value)} style={{ marginTop: 10 }} />
          )}
          <label className="row" style={{ marginTop: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
            <span style={{ fontSize: 14 }}>Set this model as the default</span>
          </label>
        </div>

        <div style={{ marginBottom: 18 }}>
          <label className="field-label" htmlFor="pr">AI instructions (prompt)</label>
          <textarea id="pr" value={prompt} onChange={(e) => setPrompt(e.target.value)}
            style={{ minHeight: 200, fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.5 }} />
          <p className="help">This is exactly what the AI is told before every answer. Edit it to change tone, strictness, or rules, then Save. Clear the box and Save to restore the built-in default.</p>
        </div>

        <div className="row">
          <button className="btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
        {msg && <div className="ok">{msg}</div>}
        {error && <div className="error">{error}</div>}
      </section>
    </div>
  );
}
