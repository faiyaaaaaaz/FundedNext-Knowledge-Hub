import { useEffect, useState } from 'react';
import Link from 'next/link';

const OPENAI_MODELS = ['gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5', 'gpt-4.1-mini', 'gpt-4o'];
const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b'];

function Brand() { return <div className="brand"><img src="/favicon.svg" alt="" /><div><b>FundedNext</b><span>Admin Console</span></div></div>; }

export default function Admin() {
  const [session, setSession] = useState('');
  const [role, setRole] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [tab, setTab] = useState('access');
  const [status, setStatus] = useState(null);
  const [intercom, setIntercom] = useState('');
  const [openai, setOpenai] = useState('');
  const [groq, setGroq] = useState('');
  const [agentPassword, setAgentPassword] = useState('');
  const [provider, setProvider] = useState('groq');
  const [model, setModel] = useState('openai/gpt-oss-120b');
  const [customModel, setCustomModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [theme, setTheme] = useState('light');

  useEffect(() => {
    const savedSession = localStorage.getItem('appSession') || '';
    const savedRole = localStorage.getItem('appRole') || '';
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme); document.documentElement.setAttribute('data-theme', savedTheme);
    if (savedSession && savedRole === 'admin') { setSession(savedSession); setRole(savedRole); load(savedSession); }
    else if (savedSession) { setSession(savedSession); setRole(savedRole); }
  }, []);

  async function login() {
    setLoginError('');
    try {
      const response = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not sign in.');
      if (data.role !== 'admin') throw new Error('This area requires the master password.');
      localStorage.setItem('appSession', data.token); localStorage.setItem('appRole', data.role);
      setSession(data.token); setRole(data.role); setPassword(''); load(data.token);
    } catch (e) { setLoginError(e.message); }
  }

  async function load(token = session) {
    setError('');
    try {
      const response = await fetch('/api/settings', { headers: { 'x-app-session': token } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load settings.');
      setStatus(data); setProvider(data.chatProvider || 'openai'); setModel(data.chatModel || 'gpt-4.1-mini'); setPrompt(data.chatPrompt || '');
    } catch (e) { setError(e.message); }
  }

  async function save(body, success) {
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session': session }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save changes.');
      setStatus(data); setNotice(success); return true;
    } catch (e) { setError(e.message); return false; } finally { setSaving(false); }
  }

  async function saveAgentPassword() {
    if (agentPassword.length < 10) return setError('Use at least 10 characters for the agent password.');
    if (await save({ agentPassword }, 'Agent password updated. All previous agent sessions were signed out.')) setAgentPassword('');
  }

  async function logoutAgents() {
    if (!window.confirm('Log out every agent now? They will need the current agent password to sign in again.')) return;
    await save({ logoutAgents: true }, 'All agent sessions have been ended.');
  }

  async function saveProvider() {
    const chosen = model === '__custom__' ? customModel.trim() : model;
    if (!chosen) return setError('Enter a model ID.');
    await save({ chatProvider: provider, chatModel: chosen, chatPrompt: prompt }, 'AI settings saved.');
  }

  async function saveKeys() {
    const body = {};
    if (intercom.trim()) body.intercomToken = intercom.trim();
    if (openai.trim()) body.openaiKey = openai.trim();
    if (groq.trim()) body.groqKey = groq.trim();
    if (await save(body, 'API keys saved securely.')) { setIntercom(''); setOpenai(''); setGroq(''); }
  }

  function logout() {
    localStorage.removeItem('appSession'); localStorage.removeItem('appRole'); localStorage.removeItem('appPw');
    setSession(''); setRole(''); setStatus(null);
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next);
    localStorage.setItem('theme', next); document.documentElement.setAttribute('data-theme', next);
  }

  if (!session || role !== 'admin') return <main className="login-page"><section className="login-panel admin-login"><Brand /><div className="login-copy"><span className="status-chip">Restricted area</span><h1>Admin access</h1><p>Use the master password to manage access, AI settings, and integrations.</p></div><div className="login-form"><label htmlFor="admin-password">Master password</label><input id="admin-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && login()} placeholder="Enter master password" /><button className="btn btn-primary" onClick={login}>Open admin console <span>→</span></button>{loginError && <div className="inline-error">{loginError}</div>}<Link href="/" className="back-link">← Back to assistant</Link></div></section></main>;

  const models = provider === 'groq' ? GROQ_MODELS : OPENAI_MODELS;
  return (
    <main className="admin-shell">
      <aside className="admin-sidebar"><Brand /><nav>{[
        ['access', '⌁', 'Team access'], ['ai', '✦', 'AI & model'], ['keys', '◇', 'API vault']
      ].map(([id, icon, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); setNotice(''); setError(''); }}><span>{icon}</span>{label}</button>)}</nav><div className="sidebar-foot"><Link href="/">← Back to assistant</Link><button onClick={logout}>Sign out</button></div></aside>

      <section className="admin-main">
        <header className="admin-top"><div><span className="eyebrow">Workspace settings</span><h1>{tab === 'access' ? 'Team access' : tab === 'ai' ? 'AI & model' : 'API vault'}</h1></div><button className="icon-btn" onClick={toggleTheme}>{theme === 'dark' ? '☀' : '◐'}</button></header>
        {notice && <div className="notice success">✓ {notice}</div>}{error && <div className="notice danger">{error}</div>}

        {tab === 'access' && <div className="settings-stack">
          <section className="settings-card"><div className="settings-head"><div><h2>Agent login</h2><p>Agents can use the assistant but cannot open this console or update the knowledge base.</p></div><span className={`state-pill ${status?.agentPasswordSet ? 'ready' : ''}`}>{status?.agentPasswordSet ? 'Active' : 'Not configured'}</span></div><label>New agent password</label><div className="field-action"><input type="password" value={agentPassword} onChange={(e) => setAgentPassword(e.target.value)} placeholder="At least 10 characters" /><button className="btn btn-primary" onClick={saveAgentPassword} disabled={saving}>Save password</button></div><p className="field-help">Changing this password immediately signs out every existing agent. Your master session remains active.</p></section>
          <section className="settings-card danger-card"><div className="settings-head"><div><h2>End all agent sessions</h2><p>Use this if a device or login session should no longer have access.</p></div></div><button className="btn btn-danger" onClick={logoutAgents} disabled={saving}>Log out all agents</button><p className="field-help">Agents can sign back in using the current agent password.</p></section>
          <section className="settings-card"><div className="settings-head"><div><h2>Access permissions</h2><p>Roles are enforced on the server, not just hidden in the interface.</p></div></div><div className="permission-table"><div><b>Capability</b><b>Admin</b><b>Agent</b></div>{[['Ask the assistant','✓','✓'],['View cited articles','✓','✓'],['Update knowledge base','✓','—'],['Manage API keys','✓','—'],['Manage team access','✓','—']].map((row) => <div key={row[0]}><span>{row[0]}</span><span>{row[1]}</span><span>{row[2]}</span></div>)}</div></section>
        </div>}

        {tab === 'ai' && <div className="settings-stack">
          <section className="settings-card"><div className="settings-head"><div><h2>Answer provider</h2><p>OpenAI continues to find relevant articles. This setting controls which model writes the answer.</p></div></div><div className="provider-grid"><button className={provider === 'groq' ? 'selected' : ''} onClick={() => { setProvider('groq'); setModel(GROQ_MODELS[0]); }}><b>Groq</b><span>Fast, cost-efficient answers</span></button><button className={provider === 'openai' ? 'selected' : ''} onClick={() => { setProvider('openai'); setModel(OPENAI_MODELS[0]); }}><b>OpenAI</b><span>Direct OpenAI answers</span></button></div><label>Model</label><select value={models.includes(model) ? model : '__custom__'} onChange={(e) => setModel(e.target.value)}>{models.map((item) => <option key={item} value={item}>{item}</option>)}<option value="__custom__">Custom model…</option></select>{model === '__custom__' && <input value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="Exact model ID" />}</section>
          <section className="settings-card"><div className="settings-head"><div><h2>Assistant instructions</h2><p>Controls tone, strictness, and how answers use knowledge-base excerpts.</p></div></div><textarea className="prompt-area" value={prompt} onChange={(e) => setPrompt(e.target.value)} /><button className="btn btn-primary" onClick={saveProvider} disabled={saving}>{saving ? 'Saving…' : 'Save AI settings'}</button></section>
        </div>}

        {tab === 'keys' && <div className="settings-stack"><section className="settings-card"><div className="settings-head"><div><h2>Encrypted API keys</h2><p>Keys are encrypted before storage and are never displayed again.</p></div></div>{[
          ['Intercom API key', intercom, setIntercom, status?.intercomSet], ['OpenAI API key', openai, setOpenai, status?.openaiSet], ['Groq API key', groq, setGroq, status?.groqSet]
        ].map(([label, value, setter, isSet]) => <div className="vault-field" key={label}><div><label>{label}</label><span className={`state-pill ${isSet ? 'ready' : ''}`}>{isSet ? 'Connected' : 'Not set'}</span></div><input type="password" value={value} onChange={(e) => setter(e.target.value)} placeholder="Paste to set or replace" /></div>)}<button className="btn btn-primary" onClick={saveKeys} disabled={saving}>{saving ? 'Saving…' : 'Save API keys'}</button></section></div>}
      </section>
    </main>
  );
}
