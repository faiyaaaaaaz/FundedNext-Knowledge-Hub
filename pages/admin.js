import { useEffect, useState } from 'react';
import Link from 'next/link';

const OPENAI_MODELS = ['gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'];
const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b'];
const EMPTY_TERM = { category: 'Account Type', rule_type: 'exact', match_term: '', required_term: '', notes: '', active: true };

function Brand() {
  return <div className="brand"><img src="/favicon.svg" alt="" /><div><b>FundedNext</b><span>Admin Console</span></div></div>;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  }).format(new Date(value)) + ' GMT+6';
}

export default function Admin() {
  const [session, setSession] = useState('');
  const [role, setRole] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [tab, setTab] = useState('access');
  const [status, setStatus] = useState(null);
  const [theme, setTheme] = useState('light');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [agentPassword, setAgentPassword] = useState('');
  const [provider, setProvider] = useState('groq');
  const [model, setModel] = useState('openai/gpt-oss-120b');
  const [customModel, setCustomModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [intercom, setIntercom] = useState('');
  const [openai, setOpenai] = useState('');
  const [groq, setGroq] = useState('');
  const [terms, setTerms] = useState([]);
  const [termForm, setTermForm] = useState(EMPTY_TERM);
  const [termSearch, setTermSearch] = useState('');
  const [disputes, setDisputes] = useState([]);
  const [selectedDispute, setSelectedDispute] = useState(null);
  const [reviewReason, setReviewReason] = useState('');
  const [disputeFilter, setDisputeFilter] = useState('');
  const [snippets, setSnippets] = useState([]);
  const [activity, setActivity] = useState(null);
  const [activityEmail, setActivityEmail] = useState('');
  const [activityFrom, setActivityFrom] = useState('');
  const [activityTo, setActivityTo] = useState('');
  const [allowedGoogleDomains, setAllowedGoogleDomains] = useState('');

  useEffect(() => {
    const savedSession = localStorage.getItem('appSession') || '';
    const savedRole = localStorage.getItem('appRole') || '';
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme); document.documentElement.setAttribute('data-theme', savedTheme);
    if (savedSession && savedRole === 'admin') {
      setSession(savedSession); setRole(savedRole); loadSettings(savedSession);
    } else if (savedSession) { setSession(savedSession); setRole(savedRole); }
  }, []);

  useEffect(() => {
    if (!session || role !== 'admin') return;
    if (tab === 'branding') loadTerms();
    if (tab === 'disputes') loadDisputes();
    if (tab === 'snippets') loadSnippets();
    if (tab === 'activity') loadActivity();
  }, [tab, session, role, disputeFilter]);

  function headers(json = false, token = session) {
    return { ...(json ? { 'Content-Type': 'application/json' } : {}), 'x-app-session': token };
  }

  function clearMessages() { setNotice(''); setError(''); }

  async function login() {
    setLoginError('');
    try {
      const response = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not sign in.');
      if (data.role !== 'admin') throw new Error('This area requires the master password.');
      localStorage.setItem('appSession', data.token); localStorage.setItem('appRole', data.role);
      setSession(data.token); setRole(data.role); setPassword(''); loadSettings(data.token);
    } catch (e) { setLoginError(e.message); }
  }

  async function loadSettings(token = session) {
    try {
      const response = await fetch('/api/settings', { headers: headers(false, token) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load settings.');
      setStatus(data); setProvider(data.chatProvider || 'openai'); setModel(data.chatModel || 'gpt-4.1-mini'); setPrompt(data.chatPrompt || '');
      setAllowedGoogleDomains(data.allowedGoogleDomains || '');
    } catch (e) { setError(e.message); }
  }

  async function settingsSave(body, success) {
    setSaving(true); clearMessages();
    try {
      const response = await fetch('/api/settings', { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save changes.');
      setStatus(data); setNotice(success); return true;
    } catch (e) { setError(e.message); return false; } finally { setSaving(false); }
  }

  async function loadTerms() {
    try {
      const response = await fetch('/api/branding', { headers: headers() });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setTerms(data.terms || []);
    } catch (e) { setError(e.message); }
  }

  async function saveTerm() {
    setSaving(true); clearMessages();
    try {
      const response = await fetch('/api/branding', { method: 'POST', headers: headers(true), body: JSON.stringify(termForm) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setTermForm(EMPTY_TERM); setNotice(termForm.id ? 'Brand Language rule updated.' : 'Brand Language rule added.'); await loadTerms();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  async function deleteTerm(id) {
    if (!window.confirm('Delete this Brand Language rule?')) return;
    const response = await fetch(`/api/branding?id=${id}`, { method: 'DELETE', headers: headers() });
    const data = await response.json(); if (!response.ok) return setError(data.error);
    setNotice('Brand Language rule deleted.'); loadTerms();
  }

  async function loadDisputes() {
    try {
      const query = disputeFilter ? `?status=${disputeFilter}` : '';
      const response = await fetch(`/api/disputes${query}`, { headers: headers() });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setDisputes(data.disputes || []);
      if (!disputeFilter) setStatus((current) => ({ ...(current || {}), pendingDisputes: (data.disputes || []).filter((item) => item.status === 'pending').length }));
      if (selectedDispute) setSelectedDispute((data.disputes || []).find((item) => item.id === selectedDispute.id) || null);
    } catch (e) { setError(e.message); }
  }

  async function disputeAction(action) {
    if (!selectedDispute) return;
    if ((action === 'approve' || action === 'reject') && reviewReason.trim().length < 5) return setError('Enter your review reason first.');
    setSaving(true); clearMessages();
    try {
      const response = await fetch('/api/disputes', {
        method: 'PATCH', headers: headers(true),
        body: JSON.stringify({ id: selectedDispute.id, action, approvalReason: reviewReason })
      });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setSelectedDispute(data.dispute); setReviewReason(''); setNotice(action === 'generate' ? 'Corrective snippet generated and activated.' : `Dispute ${action}d.`);
      await loadDisputes(); if (action === 'generate') await loadSnippets();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  }

  async function loadSnippets() {
    try {
      const response = await fetch('/api/snippets', { headers: headers() });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setSnippets(data.snippets || []);
    } catch (e) { setError(e.message); }
  }

  async function updateSnippet(snippet, updates) {
    const response = await fetch('/api/snippets', { method: 'PATCH', headers: headers(true), body: JSON.stringify({ id: snippet.id, ...updates }) });
    const data = await response.json(); if (!response.ok) return setError(data.error);
    setNotice('Snippet updated.'); loadSnippets();
  }

  async function deleteSnippet(id) {
    if (!window.confirm('Delete this corrective snippet permanently?')) return;
    const response = await fetch(`/api/snippets?id=${id}`, { method: 'DELETE', headers: headers() });
    const data = await response.json(); if (!response.ok) return setError(data.error);
    setNotice('Snippet deleted.'); loadSnippets();
  }

  async function loadActivity() {
    try {
      const query = new URLSearchParams();
      if (activityEmail.trim()) query.set('email', activityEmail.trim());
      if (activityFrom) query.set('from', activityFrom);
      if (activityTo) query.set('to', activityTo);
      const response = await fetch(`/api/activity?${query}`, { headers: headers() });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setActivity(data);
    } catch (e) { setError(e.message); }
  }

  async function clearActivityFilters() {
    setActivityEmail(''); setActivityFrom(''); setActivityTo('');
    try {
      const response = await fetch('/api/activity', { headers: headers() });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setActivity(data);
    } catch (e) { setError(e.message); }
  }

  function logout() {
    localStorage.removeItem('appSession'); localStorage.removeItem('appRole'); localStorage.removeItem('appPw');
    setSession(''); setRole(''); setStatus(null);
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next);
    localStorage.setItem('theme', next); document.documentElement.setAttribute('data-theme', next);
  }

  if (!session || role !== 'admin') return (
    <main className="login-page"><section className="login-panel admin-login"><Brand /><div className="login-copy"><span className="status-chip">Restricted area</span><h1>Admin access</h1><p>Use the master password to manage quality, access, and integrations.</p></div><div className="login-form"><label>Master password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && login()} placeholder="Enter master password" /><button className="btn btn-primary" onClick={login}>Open Admin Console →</button>{loginError && <div className="inline-error">{loginError}</div>}<Link href="/" className="back-link">← Back to assistant</Link></div></section></main>
  );

  const navigation = [
    ['access', '⌁', 'Team access'], ['ai', '✦', 'AI & model'], ['branding', 'Aa', 'Brand Language'],
    ['disputes', '⚑', 'Disputes'], ['snippets', '⌘', 'Snippets'], ['activity', '◫', 'Activity logs'], ['keys', '◇', 'API vault']
  ];
  const titles = Object.fromEntries(navigation.map(([id,, title]) => [id, title]));
  const models = provider === 'groq' ? GROQ_MODELS : OPENAI_MODELS;
  const filteredTerms = terms.filter((term) => `${term.category} ${term.match_term || ''} ${term.required_term} ${term.notes || ''}`.toLowerCase().includes(termSearch.toLowerCase()));

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar"><Brand /><nav>{navigation.map(([id, icon, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); clearMessages(); }}><span>{icon}</span>{label}{id === 'disputes' && status?.pendingDisputes > 0 && <em>{status.pendingDisputes}</em>}</button>)}</nav><div className="sidebar-foot"><Link href="/">← Back to assistant</Link><button onClick={logout}>Sign out</button></div></aside>
      <section className="admin-main">
        <header className="admin-top"><div><span className="eyebrow">Workspace settings</span><h1>{titles[tab]}</h1></div><button className="icon-btn" onClick={toggleTheme}>{theme === 'dark' ? '☀' : '◐'}</button></header>
        {notice && <div className="notice success">✓ {notice}</div>}{error && <div className="notice danger">{error}</div>}

        {tab === 'access' && <div className="settings-stack">
          <section className="settings-card"><div className="settings-head"><div><h2>Google sign-in</h2><p>Only Google accounts from these company domains can enter the Agent workspace.</p></div><span className={`state-pill ${status?.googleAuthConfigured ? 'ready' : ''}`}>{status?.googleAuthConfigured ? 'App configured' : 'Vercel setup needed'}</span></div><label>Allowed email domains</label><div className="field-action"><input value={allowedGoogleDomains} onChange={(e) => setAllowedGoogleDomains(e.target.value)} placeholder="fundednext.com, example.com" /><button className="btn btn-primary" disabled={saving} onClick={() => settingsSave({ allowedGoogleDomains }, 'Google access domains saved.')}>Save domains</button></div><p className="field-help">Separate multiple domains with commas.</p></section>
          <section className="settings-card"><div className="settings-head"><div><h2>Agent login</h2><p>Agents can use the assistant but cannot access Admin controls.</p></div><span className={`state-pill ${status?.agentPasswordSet ? 'ready' : ''}`}>{status?.agentPasswordSet ? 'Active' : 'Not configured'}</span></div><label>New agent password</label><div className="field-action"><input type="password" value={agentPassword} onChange={(e) => setAgentPassword(e.target.value)} placeholder="At least 10 characters" /><button className="btn btn-primary" disabled={saving} onClick={async () => { if (agentPassword.length < 10) return setError('Use at least 10 characters.'); if (await settingsSave({ agentPassword }, 'Agent password updated. Existing agent sessions ended.')) setAgentPassword(''); }}>Save password</button></div></section>
          <section className="settings-card danger-card"><div className="settings-head"><div><h2>End all agent sessions</h2><p>Agents can sign back in with the current Agent password.</p></div></div><button className="btn btn-danger" disabled={saving} onClick={() => window.confirm('Log out every Agent?') && settingsSave({ logoutAgents: true }, 'All Agent sessions ended.')}>Log out all Agents</button></section>
        </div>}

        {tab === 'ai' && <div className="settings-stack">
          <section className="settings-card"><div className="settings-head"><div><h2>Answer provider</h2><p>OpenAI finds relevant FAQs. This controls which model writes the answer.</p></div></div><div className="provider-grid"><button className={provider === 'groq' ? 'selected' : ''} onClick={() => { setProvider('groq'); setModel(GROQ_MODELS[0]); }}><b>Groq</b><span>Fast, cost-efficient answers</span></button><button className={provider === 'openai' ? 'selected' : ''} onClick={() => { setProvider('openai'); setModel(OPENAI_MODELS[0]); }}><b>OpenAI</b><span>Direct OpenAI answers</span></button></div><label>Model</label><select value={models.includes(model) ? model : '__custom__'} onChange={(e) => setModel(e.target.value)}>{models.map((item) => <option key={item}>{item}</option>)}<option value="__custom__">Custom model…</option></select>{model === '__custom__' && <input value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="Exact model ID" />}</section>
          <section className="settings-card"><div className="settings-head"><div><h2>Assistant instructions</h2><p>Brand Language and approved snippets are enforced separately.</p></div></div><textarea className="prompt-area" value={prompt} onChange={(e) => setPrompt(e.target.value)} /><button className="btn btn-primary" disabled={saving} onClick={() => { const chosen = model === '__custom__' ? customModel.trim() : model; if (!chosen) return setError('Enter a model ID.'); settingsSave({ chatProvider: provider, chatModel: chosen, chatPrompt: prompt }, 'AI settings saved.'); }}>Save AI settings</button></section>
        </div>}

        {tab === 'branding' && <div className="admin-split">
          <section className="settings-card sticky-form"><div className="settings-head"><div><h2>{termForm.id ? 'Edit rule' : 'Add Brand Language rule'}</h2><p>Changes apply to future answers without a redeployment.</p></div></div><label>Category</label><input value={termForm.category} onChange={(e) => setTermForm({ ...termForm, category: e.target.value })} placeholder="Account Type, Platform, Team Name…" /><label>Rule type</label><select value={termForm.rule_type} onChange={(e) => setTermForm({ ...termForm, rule_type: e.target.value })}><option value="exact">Exact spelling and capitalization</option><option value="replacement">Replace prohibited wording</option><option value="context">Context instruction</option></select>{termForm.rule_type === 'replacement' && <><label>Prohibited wording</label><input value={termForm.match_term} onChange={(e) => setTermForm({ ...termForm, match_term: e.target.value })} placeholder="Example: payout" /></>}<label>Required wording</label><input value={termForm.required_term} onChange={(e) => setTermForm({ ...termForm, required_term: e.target.value })} placeholder="Example: Performance Reward" /><label>Context or notes</label><textarea value={termForm.notes} onChange={(e) => setTermForm({ ...termForm, notes: e.target.value })} placeholder="When and how this wording should be used" /><label className="check-row"><input type="checkbox" checked={termForm.active} onChange={(e) => setTermForm({ ...termForm, active: e.target.checked })} /> Active rule</label><div className="row"><button className="btn btn-primary" disabled={saving} onClick={saveTerm}>{termForm.id ? 'Update rule' : 'Add rule'}</button>{termForm.id && <button className="btn btn-secondary" onClick={() => setTermForm(EMPTY_TERM)}>Cancel</button>}</div></section>
          <section className="settings-card"><div className="settings-head"><div><h2>Terminology library</h2><p>{filteredTerms.length} rules shown</p></div></div><input className="admin-search" value={termSearch} onChange={(e) => setTermSearch(e.target.value)} placeholder="Search terminology…" /><div className="rule-list">{filteredTerms.map((term) => <article key={term.id} className={!term.active ? 'inactive' : ''}><div><span className="rule-category">{term.category}</span><h3>{term.required_term}</h3>{term.match_term && <p><s>{term.match_term}</s> → <b>{term.required_term}</b></p>}{term.notes && <small>{term.notes}</small>}</div><div className="row"><button className="mini-action" onClick={() => setTermForm(term)}>Edit</button><button className="mini-action danger-text" onClick={() => deleteTerm(term.id)}>Delete</button></div></article>)}</div></section>
        </div>}

        {tab === 'disputes' && <div className="dispute-layout">
          <section className="settings-card"><div className="settings-head"><div><h2>Disputed answers</h2><p>Review Agent feedback before creating corrective instructions.</p></div><select className="compact-select" value={disputeFilter} onChange={(e) => setDisputeFilter(e.target.value)}><option value="">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="snippet_generated">Snippet generated</option></select></div><div className="dispute-list">{disputes.map((item) => <button key={item.id} className={selectedDispute?.id === item.id ? 'selected' : ''} onClick={() => { setSelectedDispute(item); setReviewReason(''); }}><span className={`status-dot ${item.status}`} /><div><b>{item.question}</b><small>{formatDate(item.created_at)} · {item.confidence ?? '—'}% confidence</small></div><em>{item.status.replace('_', ' ')}</em></button>)}{!disputes.length && <div className="empty-admin">No disputes in this view.</div>}</div></section>
          <section className="settings-card review-pane">{selectedDispute ? <><div className="settings-head"><div><span className={`review-status ${selectedDispute.status}`}>{selectedDispute.status.replace('_', ' ')}</span><h2>Dispute #{selectedDispute.id}</h2></div></div><label>Question</label><div className="review-block">{selectedDispute.question}</div><label>AI answer</label><div className="review-block answer-copy">{selectedDispute.answer}</div><label>Agent’s reason</label><div className="review-block dispute-reason">{selectedDispute.dispute_reason}</div>{selectedDispute.sources?.length > 0 && <><label>Sources shown to Agent</label><div className="review-links">{selectedDispute.sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={index}>{source.title} ↗</a>)}</div></>}{selectedDispute.status === 'pending' && <><label>Your review reason</label><textarea value={reviewReason} onChange={(e) => setReviewReason(e.target.value)} placeholder="Why are you approving or rejecting this dispute?" /><div className="row"><button className="btn btn-primary" disabled={saving} onClick={() => disputeAction('approve')}>Approve dispute</button><button className="btn btn-secondary" disabled={saving} onClick={() => disputeAction('reject')}>Reject</button></div></>}{selectedDispute.status === 'approved' && <><label>Admin approval reason</label><div className="review-block">{selectedDispute.approval_reason}</div><button className="btn btn-primary" disabled={saving} onClick={() => disputeAction('generate')}>{saving ? 'Checking FAQs and generating…' : 'Generate corrective snippet'}</button></>}{selectedDispute.status === 'snippet_generated' && <><label>Generated instruction</label><div className="review-block snippet-result">{selectedDispute.generated_snippet}</div><button className="btn btn-secondary" onClick={() => setTab('snippets')}>Open Snippets</button></>}</> : <div className="empty-admin tall">Select a dispute to review its full context.</div>}</section>
        </div>}

        {tab === 'snippets' && <div className="settings-stack"><section className="settings-card"><div className="settings-head"><div><h2>Corrective snippets</h2><p>Approved instructions are automatically applied when their trigger words match a future question.</p></div><span className="state-pill ready">{snippets.filter((item) => item.active).length} active</span></div><div className="snippet-list">{snippets.map((snippet) => <article key={snippet.id} className={!snippet.active ? 'inactive' : ''}><div className="snippet-head"><div><span>#{snippet.id}</span><h3>{snippet.title}</h3></div><label className="toggle"><input type="checkbox" checked={snippet.active} onChange={(e) => updateSnippet(snippet, { active: e.target.checked })} /><i /></label></div><label>Triggers</label><p className="trigger-text">{snippet.trigger_terms}</p><label>Instruction</label><textarea defaultValue={snippet.instruction} onBlur={(e) => e.target.value !== snippet.instruction && updateSnippet(snippet, { instruction: e.target.value })} /><div className="snippet-foot"><small>Created {formatDate(snippet.created_at)}</small><button className="mini-action danger-text" onClick={() => deleteSnippet(snippet.id)}>Delete</button></div></article>)}{!snippets.length && <div className="empty-admin">Approved disputes will appear here after you generate their snippets.</div>}</div></section></div>}

        {tab === 'activity' && <div className="settings-stack"><section className="settings-card activity-filters"><div className="settings-head"><div><h2>Filter activity</h2><p>Dates are interpreted in GMT+6.</p></div></div><div className="filter-grid"><div><label>User email</label><input type="search" value={activityEmail} onChange={(e) => setActivityEmail(e.target.value)} placeholder="Search an email address" /></div><div><label>From</label><input type="date" value={activityFrom} onChange={(e) => setActivityFrom(e.target.value)} /></div><div><label>To</label><input type="date" value={activityTo} onChange={(e) => setActivityTo(e.target.value)} /></div><button className="btn btn-primary" onClick={loadActivity}>Apply filters</button><button className="btn btn-secondary" onClick={() => { setActivityEmail(''); setActivityFrom(''); setActivityTo(''); }}>Clear</button></div></section>{activity && <><div className="activity-kpis">{[['Users', activity.summary.users], ['Queries', activity.summary.queries], ['Question words', activity.summary.questionWords.toLocaleString()], ['Input tokens', activity.summary.inputTokens.toLocaleString()], ['Output tokens', activity.summary.outputTokens.toLocaleString()], ['Estimated cost', `$${activity.summary.estimatedCost.toFixed(4)}`]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><section className="settings-card"><div className="settings-head"><div><h2>Activity results</h2><p>{activity.logs.length} events match the current filters.</p></div></div><div className="activity-table detailed"><div><b>Time</b><b>Google user</b><b>Email</b><b>Event</b><b>Words</b><b>Input</b><b>Output</b><b>Model</b><b>Status</b></div>{activity.logs.map((log) => <div key={log.id}><span>{formatDate(log.created_at)}</span><span>{log.user_name || (log.actor_role === 'admin' ? 'Master Admin' : 'Legacy Agent')}</span><span title={log.user_email || ''}>{log.user_email || '—'}</span><span>{log.event_type}</span><span>{log.question_word_count || 0}</span><span>{log.input_tokens || 0}</span><span>{log.output_tokens || 0}</span><span title={log.model || ''}>{log.provider || '—'}{log.model ? ` · ${log.model}` : ''}</span><span className={log.success ? 'good' : 'bad'}>{log.success ? 'Success' : 'Failed'}</span></div>)}</div></section></>}</div>}

        {tab === 'keys' && <div className="settings-stack"><section className="settings-card"><div className="settings-head"><div><h2>Encrypted API keys</h2><p>Keys are encrypted before storage and never displayed again.</p></div></div>{[['Intercom API key',intercom,setIntercom,status?.intercomSet],['OpenAI API key',openai,setOpenai,status?.openaiSet],['Groq API key',groq,setGroq,status?.groqSet]].map(([label,value,setter,isSet]) => <div className="vault-field" key={label}><div><label>{label}</label><span className={`state-pill ${isSet ? 'ready' : ''}`}>{isSet ? 'Connected' : 'Not set'}</span></div><input type="password" value={value} onChange={(e) => setter(e.target.value)} placeholder="Paste to set or replace" /></div>)}<button className="btn btn-primary" disabled={saving} onClick={async () => { const body = {}; if (intercom.trim()) body.intercomToken = intercom.trim(); if (openai.trim()) body.openaiKey = openai.trim(); if (groq.trim()) body.groqKey = groq.trim(); if (await settingsSave(body, 'API keys saved securely.')) { setIntercom(''); setOpenai(''); setGroq(''); } }}>Save API keys</button></section></div>}
      </section>
    </main>
  );
}
