import { useState, useEffect } from 'react';
import Link from 'next/link';

const OPENAI_MODELS = [
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna (fast, low cost)' },
  { id: 'gpt-5.6', label: 'GPT-5.6 (strongest)' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  { id: 'gpt-4o', label: 'GPT-4o' }
];
const GROQ_MODELS = [
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (best quality)' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (faster)' },
  { id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B' }
];
const CUSTOM = '__custom__';

export default function Admin() {
  const [pw, setPw] = useState('');
  const [authed, setAuthed] = useState(false);
  const [pwInput, setPwInput] = useState('');
  const [status, setStatus] = useState(null);
  const [intercom, setIntercom] = useState('');
  const [openai, setOpenai] = useState('');
  const [groq, setGroq] = useState('');
  const [provider, setProvider] = useState('openai');
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

  async function loadStatus(password) {
    setError('');
    try {
      const response = await fetch('/api/settings', { headers: { 'x-app-password': password } });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) logout();
        throw new Error(data.error || 'Could not load.');
      }
      setStatus(data);
      const currentProvider = data.chatProvider === 'groq' ? 'groq' : 'openai';
      const options = currentProvider === 'groq' ? GROQ_MODELS : OPENAI_MODELS;
      const currentModel = data.chatModel || (currentProvider === 'groq' ? 'openai/gpt-oss-120b' : 'gpt-5.6-luna');
      setProvider(currentProvider);
      if (options.some((model) => model.id === currentModel)) setSelectedModel(currentModel);
      else { setSelectedModel(CUSTOM); setCustomModel(currentModel); }
      setPrompt(data.chatPrompt || '');
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

  function changeProvider(nextProvider) {
    setProvider(nextProvider);
    setSelectedModel(nextProvider === 'groq' ? 'openai/gpt-oss-120b' : 'gpt-5.6-luna');
    setCustomModel('');
    setMakeDefault(false);
  }

  async function save() {
    setError(''); setMsg(''); setSaving(true);
    try {
      const body = { chatPrompt: prompt };
      if (intercom.trim()) body.intercomToken = intercom.trim();
      if (openai.trim()) body.openaiKey = openai.trim();
      if (groq.trim()) body.groqKey = groq.trim();
      if (makeDefault) {
        const chosen = selectedModel === CUSTOM ? customModel.trim() : selectedModel;
        if (!chosen) throw new Error('Please enter a model name.');
        body.chatProvider = provider;
        body.chatModel = chosen;
      }
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': pw },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) logout();
        throw new Error(data.error || 'Save failed.');
      }
      setStatus(data);
      setIntercom(''); setOpenai(''); setGroq(''); setMakeDefault(false);
      setPrompt(data.chatPrompt || '');
      setMsg('Saved.');
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  const selectStyle = {
    width: '100%', padding: '13px 14px', border: '1px solid var(--line)',
    borderRadius: 10, fontSize: 15, background: 'var(--input-bg)', color: 'var(--ink)'
  };

  if (!authed) {
    return (
      <div className="wrap center-screen"><div className="login-box card">
        <div className="eyebrow">Knowledge Hub · Admin</div>
        <h2 style={{ marginTop: 6, marginBottom: 18 }}>Enter password</h2>
        <input type="password" value={pwInput} placeholder="Password" onChange={(e) => setPwInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && login()} />
        <div style={{ marginTop: 12 }}><button className="btn" onClick={login} style={{ width: '100%' }}>Continue</button></div>
      </div></div>
    );
  }

  function KeyField({ id, label, value, setValue, isSet, help }) {
    return (
      <div style={{ marginBottom: 18 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label className="field-label" htmlFor={id}>{label}</label>
          <span className={'pill' + (isSet ? ' set' : '')}>{isSet ? 'set ✓' : 'not set'}</span>
        </div>
        <input id={id} type="password" value={value} placeholder="Paste to set or replace" onChange={(e) => setValue(e.target.value)} />
        {help && <p className="help">{help}</p>}
      </div>
    );
  }

  return (
    <div className="wrap">
      <header className="topbar">
        <div><div className="eyebrow">Knowledge Hub</div><div className="wordmark">API <span>Vault</span></div></div>
        <nav className="row">
          <Link className="navlink" href="/">Back to chat</Link>
          <button className="navlink" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={logout}>Sign out</button>
        </nav>
      </header>

      <section className="card">
        <p className="help" style={{ marginTop: 0 }}>Keys are encrypted before storage and never shown again. Leave a field blank to keep the current key.</p>
        <KeyField id="ic" label="Intercom API key" value={intercom} setValue={setIntercom} isSet={status && status.intercomSet} />
        <KeyField id="oa" label="OpenAI API key" value={openai} setValue={setOpenai} isSet={status && status.openaiSet}
          help="Required for finding the right knowledge-base articles, even when Groq writes the answer." />
        <KeyField id="gq" label="Groq API key" value={groq} setValue={setGroq} isSet={status && status.groqSet}
          help="Optional. When selected below, Groq writes answers and OpenAI is used only as an automatic backup." />

        <div style={{ marginBottom: 18 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label className="field-label" htmlFor="pv">Answer provider</label>
            <span className="pill">default: {status ? status.chatProvider : '—'}</span>
          </div>
          <select id="pv" value={provider} onChange={(e) => changeProvider(e.target.value)} style={selectStyle}>
            <option value="openai">OpenAI</option><option value="groq">Groq</option>
          </select>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label className="field-label" htmlFor="md">Answering model</label>
            <span className="pill">default: {status ? status.chatModel : '—'}</span>
          </div>
          <select id="md" value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} style={selectStyle}>
            {(provider === 'groq' ? GROQ_MODELS : OPENAI_MODELS).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            <option value={CUSTOM}>Custom…</option>
          </select>
          {selectedModel === CUSTOM && <input type="text" value={customModel} placeholder="Exact model ID" onChange={(e) => setCustomModel(e.target.value)} style={{ marginTop: 10 }} />}
          <label className="row" style={{ marginTop: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
            <span style={{ fontSize: 14 }}>Set this provider and model as the default</span>
          </label>
        </div>

        <div style={{ marginBottom: 18 }}>
          <label className="field-label" htmlFor="pr">AI instructions (prompt)</label>
          <textarea id="pr" value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ minHeight: 200, fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.5 }} />
          <p className="help">This is what the AI is told before every answer. Clear the box and Save to restore the built-in default.</p>
        </div>

        <div className="row"><button className="btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
        {msg && <div className="ok">{msg}</div>}
        {error && <div className="error">{error}</div>}
      </section>
    </div>
  );
}
