import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { getSupabaseBrowser } from '../lib/supabaseBrowser';

const OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini'];
const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b'];
const EMPTY_TERM = { category: 'Account Type', rule_type: 'exact', match_term: '', required_term: '', notes: '', active: true };
const ACTIVITY_PAGE_SIZE = 12;

function Logo({ className = '' }) {
  return (
    <svg className={`fn-logo ${className}`} viewBox="12 15 41 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path className="fn-letters" d="M15 19h13v5.4h-7.4v4.1H27v5.3h-6.4V45H15z" />
      <path className="fn-letters" d="M31 19h5.1l9 12.4V19h5.6v26h-5.1l-9-12.3V45H31z" />
      <path className="fn-tri" d="M41.4 19H50.7v9.3z" />
    </svg>
  );
}

function Brand({ label = 'Admin Console' }) {
  return <div className="brand"><span className="brand-mark"><Logo /></span><div><b>FundedNext</b><span>{label}</span></div></div>;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  }).format(new Date(value)) + ' GMT+6';
}

function formatDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function syncStatusLabel(status) {
  return { success: 'Success', partial: 'In progress', failed: 'Failed', skipped: 'Skipped' }[status] || status;
}

function initials(name, email) {
  const base = String(name || email || '?').trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

/* ---------- date helpers (GMT+6) ---------- */
function pad(n) { return String(n).padStart(2, '0'); }
function isoOf(y, m0, d) { return `${y}-${pad(m0 + 1)}-${pad(d)}`; }
function dhakaTodayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function shiftIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return isoOf(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
}
function fmtMD(iso) { const [y, m, d] = iso.split('-').map(Number); return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d))); }
function fmtMDY(iso) { const [y, m, d] = iso.split('-').map(Number); return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d))); }
function rangeLabel(from, to) {
  if (!from && !to) return 'All time';
  if (from && !to) return `From ${fmtMDY(from)}`;
  if (!from && to) return `Until ${fmtMDY(to)}`;
  if (from === to) return fmtMDY(from);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${sameYear ? fmtMD(from) : fmtMDY(from)} – ${fmtMDY(to)}`;
}
function monthName(y, m0) { return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(Date.UTC(y, m0, 1))); }

function MonthGrid({ year, month, from, to, hoverIso, onPick, onHover, maxIso }) {
  const startDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  const end = to || (from && hoverIso && hoverIso > from ? hoverIso : '');
  return (
    <div className="cal-grid">
      {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => <div key={d} className="cal-dow">{d}</div>)}
      {cells.map((d, i) => {
        if (!d) return <div key={i} />;
        const iso = isoOf(year, month, d);
        const disabled = maxIso && iso > maxIso;
        const isStart = from && iso === from;
        const isEnd = end && iso === end;
        const inRange = from && end && iso > from && iso < end;
        const single = from && !end && isStart;
        const cls = ['cal-day'];
        if (disabled) cls.push('disabled');
        if (inRange) cls.push('in-range');
        if (isStart || isEnd) { cls.push('edge'); if (single) cls.push('single'); else if (isStart) cls.push('start'); else cls.push('end'); }
        return <button key={i} type="button" disabled={disabled} className={cls.join(' ')} onMouseEnter={() => onHover(iso)} onClick={() => onPick(iso)}>{d}</button>;
      })}
    </div>
  );
}

function DateRangeFilter({ from, to, onApply }) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [tmpFrom, setTmpFrom] = useState(from || '');
  const [tmpTo, setTmpTo] = useState(to || '');
  const [hoverIso, setHoverIso] = useState('');
  const today = dhakaTodayIso();
  const initialView = (to || from || today);
  const [viewY, setViewY] = useState(Number(initialView.slice(0, 4)));
  const [viewM, setViewM] = useState(Number(initialView.slice(5, 7)) - 1);
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setShowCustom(false); } }
    if (open) document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const presets = [
    ['Today', [today, today]],
    ['Yesterday', [shiftIso(today, -1), shiftIso(today, -1)]],
    ['Past 7 days', [shiftIso(today, -6), today]],
    ['Past 30 days', [shiftIso(today, -29), today]],
    ['This month', [`${today.slice(0, 7)}-01`, today]],
    ['Past 3 months', [shiftIso(today, -90), today]],
    ['Past 12 months', [shiftIso(today, -365), today]],
    ['Year to date', [`${today.slice(0, 4)}-01-01`, today]],
    ['All time', ['', '']]
  ];
  const activeKey = presets.find(([, [f, t]]) => f === (from || '') && t === (to || ''))?.[0] || (from || to ? 'Custom' : 'All time');

  function applyPreset(range) { onApply(range[0], range[1]); setOpen(false); setShowCustom(false); }
  function pick(iso) {
    if (!tmpFrom || (tmpFrom && tmpTo)) { setTmpFrom(iso); setTmpTo(''); }
    else if (iso < tmpFrom) { setTmpFrom(iso); setTmpTo(''); }
    else setTmpTo(iso);
  }
  function applyCustom() {
    if (!tmpFrom) return;
    onApply(tmpFrom, tmpTo || tmpFrom);
    setOpen(false); setShowCustom(false);
  }
  function openCustom() {
    setTmpFrom(from || ''); setTmpTo(to || ''); setHoverIso('');
    const base = to || from || today;
    setViewY(Number(base.slice(0, 4))); setViewM(Number(base.slice(5, 7)) - 1);
    setShowCustom(true);
  }
  function stepMonth(delta) {
    const dt = new Date(Date.UTC(viewY, viewM + delta, 1));
    setViewY(dt.getUTCFullYear()); setViewM(dt.getUTCMonth());
  }
  const rightDt = new Date(Date.UTC(viewY, viewM + 1, 1));

  return (
    <div className="date-filter" ref={ref}>
      <button type="button" className={`date-trigger ${open ? 'open' : ''}`} onClick={() => { setOpen((v) => !v); setShowCustom(false); }}>
        <span className="cal-ico">🗓</span>{rangeLabel(from, to)}<span className="caret">▾</span>
      </button>
      {open && (
        <div className="date-pop">
          <div className="date-presets">
            {presets.map(([label, range]) => (
              <button key={label} type="button" className={`date-preset ${activeKey === label ? 'active' : ''}`} onMouseEnter={() => setShowCustom(false)} onClick={() => applyPreset(range)}>
                {label}{activeKey === label && <span className="ck">✓</span>}
              </button>
            ))}
            <button type="button" className={`date-preset custom ${activeKey === 'Custom' ? 'active' : ''}`} onMouseEnter={openCustom} onClick={openCustom}>
              Custom range{(activeKey === 'Custom' || showCustom) && <span className="ck">✓</span>}
            </button>
          </div>
          {showCustom && (
            <div className="date-cal">
              <div className="range-head">
                <div><label>From</label><b className={tmpFrom ? '' : 'empty'}>{tmpFrom ? fmtMDY(tmpFrom) : 'Select date'}</b></div>
                <div><label>To</label><b className={tmpTo ? '' : 'empty'}>{tmpTo ? fmtMDY(tmpTo) : 'Select date'}</b></div>
              </div>
              <div className="cal-wrap">
                <div>
                  <div className="cal-nav"><button type="button" onClick={() => stepMonth(-1)}>‹</button><b>{monthName(viewY, viewM)}</b><span /></div>
                  <MonthGrid year={viewY} month={viewM} from={tmpFrom} to={tmpTo} hoverIso={hoverIso} onPick={pick} onHover={setHoverIso} maxIso={today} />
                </div>
                <div>
                  <div className="cal-nav"><span /><b>{monthName(rightDt.getUTCFullYear(), rightDt.getUTCMonth())}</b><button type="button" onClick={() => stepMonth(1)}>›</button></div>
                  <MonthGrid year={rightDt.getUTCFullYear()} month={rightDt.getUTCMonth()} from={tmpFrom} to={tmpTo} hoverIso={hoverIso} onPick={pick} onHover={setHoverIso} maxIso={today} />
                </div>
              </div>
              <div className="date-foot">
                <button type="button" className="btn btn-secondary btn-small" onClick={() => { setOpen(false); setShowCustom(false); }}>Cancel</button>
                <button type="button" className="btn btn-primary btn-small" disabled={!tmpFrom} onClick={applyCustom}>Apply range</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Admin() {
  const [session, setSession] = useState('');
  const [role, setRole] = useState('');
  const [loginError, setLoginError] = useState('');
  const [tab, setTab] = useState('access');
  const [status, setStatus] = useState(null);
  const [theme, setTheme] = useState('dark');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [provider, setProvider] = useState('groq');
  const [model, setModel] = useState('gpt-4o');
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
  const [activityPage, setActivityPage] = useState(1);
  const [allowedGoogleDomains, setAllowedGoogleDomains] = useState('');
  const [smartRetrieval, setSmartRetrieval] = useState(true);
  const [normalUserGptFallback, setNormalUserGptFallback] = useState(true);
  const [adminAutoFallback, setAdminAutoFallback] = useState(true);
  const [fallbackProvider, setFallbackProvider] = useState('openai');
  const [fallbackModel, setFallbackModel] = useState('gpt-4o');
  const [autoSync, setAutoSync] = useState(null);
  const [runningSync, setRunningSync] = useState(false);
  const [expandedSync, setExpandedSync] = useState(null);
  const [knowledge, setKnowledge] = useState(null);
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [expandedScope, setExpandedScope] = useState(null);
  const [articleScopeDrafts, setArticleScopeDrafts] = useState({});
  const [savingArticleScope, setSavingArticleScope] = useState('');
  const [articleScopeSearch, setArticleScopeSearch] = useState('');
  const [openDoc, setOpenDoc] = useState(null);
  const [docDraft, setDocDraft] = useState(null);
  const [calc, setCalc] = useState(null);
  const [calcSearch, setCalcSearch] = useState('');
  const [openInst, setOpenInst] = useState(null);
  const [instDraft, setInstDraft] = useState(null);
  const [newLev, setNewLev] = useState({ stepKey: '', marketType: 'Currency', phase: 'any', leverage: '' });
  const [groqKeys, setGroqKeys] = useState(null);
  const [newGroqKey, setNewGroqKey] = useState({ label: '', key: '' });

  useEffect(() => {
    const savedSession = localStorage.getItem('appSession') || '';
    const savedRole = localStorage.getItem('appRole') || '';
    const savedTheme = localStorage.getItem('theme') || 'dark';
    setTheme(savedTheme); document.documentElement.setAttribute('data-theme', savedTheme);
    if (savedSession && savedRole === 'admin') {
      setSession(savedSession); setRole(savedRole); loadSettings(savedSession);
    } else if (savedSession) { setSession(savedSession); setRole(savedRole); }
    else completeGoogleLogin();
  }, []);

  useEffect(() => {
    if (!session || role !== 'admin') return;
    if (tab === 'branding') loadTerms();
    if (tab === 'disputes') loadDisputes();
    if (tab === 'snippets') loadSnippets();
    if (tab === 'activity') loadActivity();
    if (tab === 'autosync') loadAutoSync();
    if (tab === 'knowledge') loadKnowledge();
    if (tab === 'calcdata') loadCalc();
    if (tab === 'groqkeys') loadGroqKeys();
  }, [tab, session, role, disputeFilter]);

  function headers(json = false, token = session) {
    return { ...(json ? { 'Content-Type': 'application/json' } : {}), 'x-app-session': token };
  }

  function clearMessages() { setNotice(''); setError(''); }

  function handleAuthLoss(response) {
    if (response.status === 401) { logout(); return true; }
    return false;
  }

  async function completeGoogleLogin() {
    const client = getSupabaseBrowser();
    if (!client) return;
    setLoginError('');
    try {
      const { data: authData } = await client.auth.getSession();
      if (!authData.session?.access_token) return;
      const response = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ googleAccessToken: authData.session.access_token }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not sign in.');
      if (result.role !== 'admin') throw new Error('Your Google account is not listed in ADMIN_GOOGLE_EMAILS.');
      localStorage.setItem('appSession', result.token); localStorage.setItem('appRole', result.role);
      setSession(result.token); setRole(result.role); loadSettings(result.token);
    } catch (e) { setLoginError(e.message); }
  }

  async function googleLogin() {
    const client = getSupabaseBrowser();
    if (!client) return setLoginError('Google sign-in is not configured.');
    const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}/admin` } });
    if (error) setLoginError(error.message);
  }

  async function loadSettings(token = session) {
    try {
      const response = await fetch('/api/settings', { headers: headers(false, token) });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load settings.');
      setStatus(data); setProvider(data.chatProvider || 'openai'); setModel(data.chatModel || 'gpt-4o'); setPrompt(data.chatPrompt || '');
      setAllowedGoogleDomains(data.allowedGoogleDomains || '');
      setSmartRetrieval(data.smartRetrieval !== false);
      setNormalUserGptFallback(data.normalUserGptFallback !== false);
      setAdminAutoFallback(data.adminAutoFallback !== false);
      setFallbackProvider(data.fallbackProvider || 'openai');
      setFallbackModel(data.fallbackModel || 'gpt-4o');
    } catch (e) { setError(e.message); }
  }

  async function loadAutoSync() {
    try {
      const response = await fetch('/api/autosync', { headers: headers() });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load auto-sync.');
      setAutoSync(data);
    } catch (e) { setError(e.message); }
  }

  async function saveAutoSync(updates, success) {
    clearMessages();
    try {
      const response = await fetch('/api/autosync', { method: 'POST', headers: headers(true), body: JSON.stringify(updates) });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save auto-sync.');
      setAutoSync((current) => ({ ...(current || {}), ...data }));
      if (success) setNotice(success);
    } catch (e) { setError(e.message); }
  }

  async function runAutoSyncNow() {
    setRunningSync(true); clearMessages();
    try {
      const response = await fetch('/api/cron-sync', { method: 'POST', headers: headers(true) });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Auto-sync could not run.');
      if (data.ran === false) setNotice(data.reason || 'Nothing to sync right now.');
      else if (data.status === 'failed') setError('Sync failed: ' + (data.error || 'unknown error'));
      else if (data.status === 'partial') setNotice(`Sync in progress — indexed ${data.articlesIndexed || 0} so far. It will finish automatically.`);
      else setNotice(`Sync complete. ${data.articlesChanged || 0} changed, ${data.articlesIndexed || 0} re-indexed.`);
      await loadAutoSync();
    } catch (e) { setError(e.message); } finally { setRunningSync(false); }
  }

  async function loadKnowledge() {
    try {
      const response = await fetch('/api/knowledge', { headers: headers() });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load knowledge.');
      setKnowledge(data);
    } catch (e) { setError(e.message); }
  }

  async function updateScopeStatus(model, status) {
    clearMessages();
    try {
      const response = await fetch('/api/knowledge', { method: 'POST', headers: headers(true), body: JSON.stringify({ action: 'scope-status', slug: model.slug, status }) });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not update the model status.');
      setKnowledge((current) => ({ ...current, scopeCatalog: data.scopeCatalog }));
      setNotice(`${model.name} is now marked ${status === 'previous' ? 'not currently live' : status}.`);
    } catch (e) { setError(e.message); }
  }

  function savedArticleScope(article, parentModel) {
    return article.scope || (article.product ? { product: article.product, model: article.model || 'all' } : { product: parentModel.product, model: parentModel.slug });
  }

  function articleScopeDraft(article, parentModel) {
    return articleScopeDrafts[String(article.id)] || savedArticleScope(article, parentModel);
  }

  function changeArticleScope(article, parentModel, changes) {
    const current = articleScopeDraft(article, parentModel);
    const next = { ...current, ...changes };
    if (changes.product && changes.product !== current.product) next.model = 'all';
    setArticleScopeDrafts((drafts) => ({ ...drafts, [String(article.id)]: next }));
  }

  function undoArticleScope(article) {
    setArticleScopeDrafts((drafts) => { const next = { ...drafts }; delete next[String(article.id)]; return next; });
  }

  async function saveArticleScope(article, parentModel) {
    const draft = articleScopeDraft(article, parentModel);
    setSavingArticleScope(String(article.id)); setError(''); setNotice('');
    try {
      const response = await fetch('/api/knowledge', { method: 'POST', headers: headers(true), body: JSON.stringify({ action: 'article-scope', articleId: article.id, product: draft.product, model: draft.model }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save the article scope.');
      setKnowledge((current) => ({ ...current, scopeCatalog: data.scopeCatalog, articleScopes: (current.articleScopes || []).map((item) => String(item.id) === String(article.id) ? { ...item, product: draft.product, model: draft.model, overridden: true } : item) }));
      undoArticleScope(article);
      setNotice(`Saved the scope for “${article.title}”. New searches will use this correction immediately.`);
    } catch (e) { setError(e.message); }
    finally { setSavingArticleScope(''); }
  }

  async function saveDoc(payload, success) {
    clearMessages();
    try {
      const response = await fetch('/api/knowledge', { method: 'POST', headers: headers(true), body: JSON.stringify(payload) });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save the document.');
      if (success) setNotice(success);
      setOpenDoc(null); setDocDraft(null);
      await loadKnowledge();
    } catch (e) { setError(e.message); }
  }

  async function deleteDoc(id) {
    if (!window.confirm('Delete this knowledge document? It will be removed from the chatbot on the next re-index.')) return;
    clearMessages();
    try {
      const response = await fetch(`/api/knowledge?id=${id}`, { method: 'DELETE', headers: headers(true) });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not delete the document.');
      setNotice('Document deleted. Re-index to update the chatbot.');
      await loadKnowledge();
    } catch (e) { setError(e.message); }
  }

  async function reindexKnowledgeNow() {
    setKnowledgeBusy(true); clearMessages();
    try {
      const response = await fetch('/api/knowledge', { method: 'POST', headers: headers(true), body: JSON.stringify({ action: 'reindex' }) });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Re-index failed.');
      setNotice(`Knowledge re-indexed — ${data.docs} document${data.docs === 1 ? '' : 's'}, ${data.chunks} searchable pieces now live in the chatbot.`);
      await loadKnowledge();
    } catch (e) { setError(e.message); } finally { setKnowledgeBusy(false); }
  }

  async function loadCalc() {
    try {
      const response = await fetch('/api/calcdata', { headers: headers() });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load calculator data.');
      setCalc(data);
    } catch (e) { setError(e.message); }
  }

  async function loadGroqKeys() {
    try {
      const response = await fetch('/api/groqkeys', { headers: headers() });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load Groq keys.');
      setGroqKeys(data.keys || []);
    } catch (e) { setError(e.message); }
  }

  async function groqKeyAction(payload, method, success) {
    clearMessages();
    try {
      const response = await fetch('/api/groqkeys', { method, headers: headers(true), body: JSON.stringify(payload) });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not update Groq keys.');
      setGroqKeys(data.keys || []);
      if (success) setNotice(success);
    } catch (e) { setError(e.message); }
  }

  async function saveInstrument(payload, success) {
    clearMessages();
    try {
      const response = await fetch('/api/calcdata', { method: 'POST', headers: headers(true), body: JSON.stringify({ kind: 'instrument', ...payload }) });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save.');
      setCalc(data); setOpenInst(null); setInstDraft(null);
      if (success) setNotice(success);
    } catch (e) { setError(e.message); }
  }

  async function saveLeverage(payload, success) {
    clearMessages();
    try {
      const response = await fetch('/api/calcdata', { method: 'POST', headers: headers(true), body: JSON.stringify({ kind: 'leverage', ...payload }) });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save.');
      setCalc(data);
      if (success) setNotice(success);
    } catch (e) { setError(e.message); }
  }

  async function removeLeverage(row) {
    if (!window.confirm('Remove this leverage row? If it was a built-in default, the default value is restored.')) return;
    clearMessages();
    try {
      const response = await fetch('/api/calcdata', { method: 'DELETE', headers: headers(true), body: JSON.stringify(row) });
      if (handleAuthLoss(response)) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not delete.');
      setCalc(data); setNotice('Leverage row removed.');
    } catch (e) { setError(e.message); }
  }

  async function settingsSave(body, success) {
    setSaving(true); clearMessages();
    try {
      const response = await fetch('/api/settings', { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
      if (handleAuthLoss(response)) return false;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save changes.');
      setStatus(data); setNotice(success); return true;
    } catch (e) { setError(e.message); return false; } finally { setSaving(false); }
  }

  async function loadTerms() {
    try {
      const response = await fetch('/api/branding', { headers: headers() });
      if (handleAuthLoss(response)) return;
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
      if (handleAuthLoss(response)) return;
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
      if (handleAuthLoss(response)) return;
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

  async function loadActivity(opts = {}) {
    const email = opts.email ?? activityEmail;
    const from = opts.from ?? activityFrom;
    const to = opts.to ?? activityTo;
    try {
      const query = new URLSearchParams();
      if (String(email).trim()) query.set('email', String(email).trim());
      if (from) query.set('from', from);
      if (to) query.set('to', to);
      const response = await fetch(`/api/activity?${query}`, { headers: headers() });
      if (handleAuthLoss(response)) return;
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setActivity(data); setActivityPage(1);
    } catch (e) { setError(e.message); }
  }

  function applyDateRange(from, to) {
    setActivityFrom(from); setActivityTo(to);
    loadActivity({ from, to });
  }

  function clearActivityFilters() {
    setActivityEmail(''); setActivityFrom(''); setActivityTo('');
    loadActivity({ email: '', from: '', to: '' });
  }

  function logout() {
    localStorage.removeItem('appSession'); localStorage.removeItem('appRole'); localStorage.removeItem('appPw');
    setSession(''); setRole(''); setStatus(null);
  }

  async function signEveryoneOut() {
    if (!window.confirm('Sign out every user? Everyone — agents and admins — will need to sign in with Google again. Your own session will end too.')) return;
    const ok = await settingsSave({ logoutAgents: true }, 'Everyone has been signed out. Redirecting you to sign in…');
    if (ok) setTimeout(logout, 1200);
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next);
    localStorage.setItem('theme', next); document.documentElement.setAttribute('data-theme', next);
  }

  if (!session || role !== 'admin') return (
    <main className="login-page"><section className="login-panel admin-login"><Brand /><div className="login-copy"><span className="status-chip">Restricted area</span><h1>Admin access</h1><p>Sign in with an approved nextventures.io Google account.</p></div><div className="login-form"><button className="google-button" onClick={googleLogin}>Continue with Google</button>{loginError && <div className="inline-error">{loginError}</div>}<Link href="/" className="back-link">← Back to assistant</Link></div></section></main>
  );

  const navigation = [
    ['access', '⌁', 'Team access'], ['ai', '✦', 'AI & model'], ['branding', 'Aa', 'Brand Language'],
    ['disputes', '⚑', 'Disputes'], ['snippets', '⌘', 'Snippets'], ['knowledge', '▤', 'Knowledge'], ['calcdata', '∑', 'Calculator data'], ['activity', '◫', 'Activity logs'],
    ['autosync', '↻', 'Automatic sync'], ['groqkeys', '⚿', 'Groq keys'], ['keys', '◇', 'API vault']
  ];
  const titles = Object.fromEntries(navigation.map(([id,, title]) => [id, title]));
  const models = provider === 'groq' ? GROQ_MODELS : OPENAI_MODELS;
  const filteredTerms = terms.filter((term) => `${term.category} ${term.match_term || ''} ${term.required_term} ${term.notes || ''}`.toLowerCase().includes(termSearch.toLowerCase()));
  const filteredArticleScopes = (knowledge?.articleScopes || []).filter((article) => `${article.title} ${article.product}`.toLowerCase().includes(articleScopeSearch.toLowerCase())).slice(0, 100);

  const activityLogs = activity?.logs || [];
  const totalPages = Math.max(1, Math.ceil(activityLogs.length / ACTIVITY_PAGE_SIZE));
  const pageStart = (activityPage - 1) * ACTIVITY_PAGE_SIZE;
  const pageLogs = activityLogs.slice(pageStart, pageStart + ACTIVITY_PAGE_SIZE);
  const pageNumbers = (() => {
    const out = []; const span = 2;
    for (let p = 1; p <= totalPages; p++) {
      if (p === 1 || p === totalPages || (p >= activityPage - span && p <= activityPage + span)) out.push(p);
      else if (out[out.length - 1] !== '…') out.push('…');
    }
    return out;
  })();

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar"><Brand /><nav>{navigation.map(([id, icon, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); clearMessages(); }}><span>{icon}</span>{label}{id === 'disputes' && status?.pendingDisputes > 0 && <em>{status.pendingDisputes}</em>}</button>)}</nav><div className="sidebar-foot"><Link href="/">← Back to assistant</Link><button onClick={logout}>Sign out</button></div></aside>
      <section className="admin-main">
        <header className="admin-top"><div><span className="eyebrow">Workspace settings</span><h1>{titles[tab]}</h1></div><button className="icon-btn" onClick={toggleTheme} aria-label="Change theme">{theme === 'dark' ? '☀' : '☾'}</button></header>
        {notice && <div className="notice success">✓ {notice}</div>}{error && <div className="notice danger">{error}</div>}

        {tab === 'access' && <div className="settings-stack">
          <section className="settings-card"><div className="settings-head"><div><h2>Google sign-in</h2><p>Access is permanently restricted to nextventures.io Google accounts.</p></div><span className={`state-pill ${status?.googleAuthConfigured && status?.adminGoogleConfigured ? 'ready' : ''}`}>{status?.googleAuthConfigured && status?.adminGoogleConfigured ? 'Configured' : 'Vercel setup needed'}</span></div><div className="permission-table"><div><span>Access rule</span><b>Required value</b><b>Status</b></div><div><span>Allowed domain</span><b>nextventures.io</b><b>Fixed</b></div><div><span>Admin list</span><b>ADMIN_GOOGLE_EMAILS</b><b>{status?.adminGoogleConfigured ? 'Configured' : 'Missing'}</b></div></div></section>
          <section className="settings-card"><div className="settings-head"><div><h2>Workspace roles</h2><p>Every user must authenticate with Google. Admin rights come only from the Vercel Admin email list.</p></div><span className="state-pill ready">Google only</span></div><div className="permission-table"><div><span>Requirement</span><b>Agent</b><b>Admin</b></div><div><span>@nextventures.io Google account</span><b>Required</b><b>Required</b></div><div><span>Listed in ADMIN_GOOGLE_EMAILS</span><b>No</b><b>Required</b></div></div></section>
          <section className="settings-card danger-card"><div className="settings-head"><div><h2>Sign everyone out</h2><p>Ends every active session across the workspace. All users — agents and admins — will have to sign in with Google again. Your own session will end too.</p></div></div><button className="btn btn-danger" disabled={saving} onClick={signEveryoneOut}>Sign everyone out</button></section>
        </div>}

        {tab === 'ai' && <div className="settings-stack">
          <section className="settings-card"><div className="settings-head"><div><h2>Automatic fallback</h2><p>Choose exactly who receives a second attempt and which provider/model handles it when the primary model fails.</p></div></div><div className="autosync-grid"><div className="field-block"><label>Fallback provider</label><select value={fallbackProvider} onChange={(e) => { const next = e.target.value; setFallbackProvider(next); setFallbackModel(next === 'groq' ? GROQ_MODELS[0] : OPENAI_MODELS[0]); }}><option value="openai">OpenAI</option><option value="groq">Groq</option></select></div><div className="field-block"><label>Fallback model</label><select value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)}>{(fallbackProvider === 'groq' ? GROQ_MODELS : OPENAI_MODELS).map((item) => <option key={item} value={item}>{item}</option>)}</select></div></div><div className="settings-head" style={{ marginTop: 18 }}><div><h3>Normal Agents</h3><p>Automatically use the fallback above when their primary request fails.</p></div><label className="toggle"><input type="checkbox" checked={normalUserGptFallback} onChange={(e) => setNormalUserGptFallback(e.target.checked)} /><i /></label></div><div className="settings-head"><div><h3>Master Admins</h3><p>Automatically use the fallback above when an Admin request fails.</p></div><label className="toggle"><input type="checkbox" checked={adminAutoFallback} onChange={(e) => setAdminAutoFallback(e.target.checked)} /><i /></label></div><button className="btn btn-primary" disabled={saving} onClick={() => settingsSave({ normalUserGptFallback, adminAutoFallback, fallbackProvider, fallbackModel }, 'Automatic fallback settings saved.')}>Save fallback settings</button><p className="field-help">The primary provider and model remain independently controlled in Answer provider below.</p></section>
          <section className="settings-card"><div className="settings-head"><div><h2>Answer provider</h2><p>OpenAI finds relevant FAQs. This controls which model writes the answer.</p></div></div><div className="provider-grid"><button className={provider === 'groq' ? 'selected' : ''} onClick={() => { setProvider('groq'); setModel(GROQ_MODELS[0]); }}><b>Groq</b><span>Fast, cost-efficient answers</span></button><button className={provider === 'openai' ? 'selected' : ''} onClick={() => { setProvider('openai'); setModel(OPENAI_MODELS[0]); }}><b>OpenAI</b><span>Direct OpenAI answers</span></button></div><label>Model</label><select value={models.includes(model) ? model : '__custom__'} onChange={(e) => setModel(e.target.value)}>{models.map((item) => <option key={item}>{item}</option>)}<option value="__custom__">Custom model…</option></select>{model === '__custom__' && <input value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="Exact model ID" />}</section>
          <section className="settings-card"><div className="settings-head"><div><h2>Smart query understanding</h2><p>Helps vague, misspelled, or ambiguous questions find the right FAQ. When a question could mean two things (for example a payout cycle versus the 24-hour Brand Promise), the assistant retrieves evidence for each meaning and answers them separately.</p></div><label className="toggle"><input type="checkbox" checked={smartRetrieval} onChange={(e) => { setSmartRetrieval(e.target.checked); settingsSave({ smartRetrieval: e.target.checked }, e.target.checked ? 'Smart query understanding turned on.' : 'Smart query understanding turned off.'); }} /><i /></label></div><p className="field-help">Adds one quick model call per question to interpret it. Concept matching for FundedNext terms stays on either way.</p></section>
          <section className="settings-card"><div className="settings-head"><div><h2>Assistant instructions</h2><p>Brand Language and approved snippets are enforced separately.</p></div></div><textarea className="prompt-area" value={prompt} onChange={(e) => setPrompt(e.target.value)} /><button className="btn btn-primary" disabled={saving} onClick={() => { const chosen = model === '__custom__' ? customModel.trim() : model; if (!chosen) return setError('Enter a model ID.'); settingsSave({ chatProvider: provider, chatModel: chosen, chatPrompt: prompt, smartRetrieval }, 'AI settings saved.'); }}>Save AI settings</button></section>
        </div>}

        {tab === 'branding' && <div className="admin-split">
          <section className="settings-card sticky-form"><div className="settings-head"><div><h2>{termForm.id ? 'Edit rule' : 'Add Brand Language rule'}</h2><p>Changes apply to future answers without a redeployment.</p></div></div><label>Category</label><input value={termForm.category} onChange={(e) => setTermForm({ ...termForm, category: e.target.value })} placeholder="Account Type, Platform, Team Name…" /><label>Rule type</label><select value={termForm.rule_type} onChange={(e) => setTermForm({ ...termForm, rule_type: e.target.value })}><option value="exact">Exact spelling and capitalization</option><option value="replacement">Replace prohibited wording</option><option value="context">Context instruction</option></select>{termForm.rule_type === 'replacement' && <><label>Prohibited wording</label><input value={termForm.match_term} onChange={(e) => setTermForm({ ...termForm, match_term: e.target.value })} placeholder="Example: payout" /></>}<label>Required wording</label><input value={termForm.required_term} onChange={(e) => setTermForm({ ...termForm, required_term: e.target.value })} placeholder="Example: Performance Reward" /><label>Context or notes</label><textarea value={termForm.notes} onChange={(e) => setTermForm({ ...termForm, notes: e.target.value })} placeholder="When and how this wording should be used" /><label className="check-row"><input type="checkbox" checked={termForm.active} onChange={(e) => setTermForm({ ...termForm, active: e.target.checked })} /> Active rule</label><div className="row"><button className="btn btn-primary" disabled={saving} onClick={saveTerm}>{termForm.id ? 'Update rule' : 'Add rule'}</button>{termForm.id && <button className="btn btn-secondary" onClick={() => setTermForm(EMPTY_TERM)}>Cancel</button>}</div></section>
          <section className="settings-card"><div className="settings-head"><div><h2>Terminology library</h2><p>{filteredTerms.length} rules shown</p></div></div><input className="admin-search" value={termSearch} onChange={(e) => setTermSearch(e.target.value)} placeholder="Search terminology…" /><div className="rule-list">{filteredTerms.map((term) => <article key={term.id} className={!term.active ? 'inactive' : ''}><div><span className="rule-category">{term.category}</span><h3>{term.required_term}</h3>{term.match_term && <p><s>{term.match_term}</s> → <b>{term.required_term}</b></p>}{term.notes && <small>{term.notes}</small>}</div><div className="row"><button className="mini-action" onClick={() => setTermForm(term)}>Edit</button><button className="mini-action danger-text" onClick={() => deleteTerm(term.id)}>Delete</button></div></article>)}</div></section>
        </div>}

        {tab === 'disputes' && <div className="dispute-layout">
          <section className="settings-card"><div className="settings-head"><div><h2>Disputed answers</h2><p>Review Agent feedback before creating corrective instructions.</p></div><select className="compact-select" value={disputeFilter} onChange={(e) => setDisputeFilter(e.target.value)}><option value="">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="snippet_generated">Snippet generated</option></select></div><div className="dispute-list">{disputes.map((item) => <button key={item.id} className={selectedDispute?.id === item.id ? 'selected' : ''} onClick={() => { setSelectedDispute(item); setReviewReason(''); }}><span className={`status-dot ${item.status}`} /><div><b>{item.question}</b><div className="dispute-submitter"><span className="dispute-avatar">{initials(item.user_name, item.user_email)}</span><span>{item.user_name || item.user_email || (item.actor_role === 'admin' ? 'Master Admin' : 'Teammate')}</span></div><small className="meta-line">{formatDate(item.created_at)} · {item.confidence ?? '—'}% confidence</small></div><em>{item.status.replace('_', ' ')}</em></button>)}{!disputes.length && <div className="empty-admin">No disputes in this view.</div>}</div></section>
          <section className="settings-card review-pane">{selectedDispute ? <><div className="settings-head"><div><span className={`review-status ${selectedDispute.status}`}>{selectedDispute.status.replace('_', ' ')}</span><h2>Dispute #{selectedDispute.id}</h2></div></div><div className="review-meta"><span className="dispute-avatar">{initials(selectedDispute.user_name, selectedDispute.user_email)}</span><div className="who"><b>{selectedDispute.user_name || selectedDispute.user_email || (selectedDispute.actor_role === 'admin' ? 'Master Admin' : 'Teammate')}</b>{selectedDispute.user_email && <small>{selectedDispute.user_email}</small>}</div><div className="when">Submitted<b>{formatDate(selectedDispute.created_at)}</b></div></div><label>Question</label><div className="review-block">{selectedDispute.question}</div><label>AI answer</label><div className="review-block answer-copy">{selectedDispute.answer}</div><label>Agent’s reason</label><div className="review-block dispute-reason">{selectedDispute.dispute_reason}</div>{selectedDispute.sources?.length > 0 && <><label>Sources shown to Agent</label><div className="review-links">{selectedDispute.sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={index}>{source.title} ↗</a>)}</div></>}{selectedDispute.status === 'pending' && <><label>Your review reason</label><textarea value={reviewReason} onChange={(e) => setReviewReason(e.target.value)} placeholder="Why are you approving or rejecting this dispute?" /><div className="row"><button className="btn btn-primary" disabled={saving} onClick={() => disputeAction('approve')}>Approve dispute</button><button className="btn btn-secondary" disabled={saving} onClick={() => disputeAction('reject')}>Reject</button></div></>}{selectedDispute.status === 'approved' && <><label>Admin approval reason</label><div className="review-block">{selectedDispute.approval_reason}</div><button className="btn btn-primary" disabled={saving} onClick={() => disputeAction('generate')}>{saving ? 'Checking FAQs and generating…' : 'Generate corrective snippet'}</button></>}{selectedDispute.status === 'snippet_generated' && <><label>Generated instruction</label><div className="review-block snippet-result">{selectedDispute.generated_snippet}</div><button className="btn btn-secondary" onClick={() => setTab('snippets')}>Open Snippets</button></>}</> : <div className="empty-admin tall">Select a dispute to review its full context.</div>}</section>
        </div>}

        {tab === 'snippets' && <div className="settings-stack"><section className="settings-card"><div className="settings-head"><div><h2>Corrective snippets</h2><p>Approved instructions are automatically applied when their trigger words match a future question.</p></div><span className="state-pill ready">{snippets.filter((item) => item.active).length} active</span></div><div className="snippet-list">{snippets.map((snippet) => <article key={snippet.id} className={!snippet.active ? 'inactive' : ''}><div className="snippet-head"><div><span>#{snippet.id}</span><h3>{snippet.title}</h3></div><label className="toggle"><input type="checkbox" checked={snippet.active} onChange={(e) => updateSnippet(snippet, { active: e.target.checked })} /><i /></label></div><label>Triggers</label><p className="trigger-text">{snippet.trigger_terms}</p><label>Instruction</label><textarea defaultValue={snippet.instruction} onBlur={(e) => e.target.value !== snippet.instruction && updateSnippet(snippet, { instruction: e.target.value })} /><div className="snippet-foot"><small>Created {formatDate(snippet.created_at)}</small><button className="mini-action danger-text" onClick={() => deleteSnippet(snippet.id)}>Delete</button></div></article>)}{!snippets.length && <div className="empty-admin">Approved disputes will appear here after you generate their snippets.</div>}</div></section></div>}

        {tab === 'activity' && <div className="settings-stack"><section className="settings-card activity-filters"><div className="settings-head"><div><h2>Filter activity</h2><p>Dates are interpreted in GMT+6.</p></div><DateRangeFilter from={activityFrom} to={activityTo} onApply={applyDateRange} /></div><div className="field-action"><input type="search" value={activityEmail} onChange={(e) => setActivityEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadActivity()} placeholder="Search a teammate’s email address" /><div className="row"><button className="btn btn-primary" onClick={() => loadActivity()}>Search</button><button className="btn btn-secondary" onClick={clearActivityFilters}>Clear</button></div></div></section>{activity && <><div className="activity-kpis">{[['Users', activity.summary.users], ['Queries', activity.summary.queries], ['Question words', activity.summary.questionWords.toLocaleString()], ['Input tokens', activity.summary.inputTokens.toLocaleString()], ['Output tokens', activity.summary.outputTokens.toLocaleString()], ['Estimated cost', `$${activity.summary.estimatedCost.toFixed(4)}`]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><section className="settings-card"><div className="settings-head"><div><h2>Activity results</h2><p className="activity-count">{activityLogs.length} event{activityLogs.length === 1 ? '' : 's'} match the current filters.</p></div></div><div className="activity-table detailed"><div><b>Time</b><b>Google user</b><b>Email</b><b>Event</b><b>Words</b><b>Input</b><b>Output</b><b>Model</b><b>Status</b></div>{pageLogs.map((log) => <div key={log.id}><span data-label="Time">{formatDate(log.created_at)}</span><span data-label="User">{log.user_name || (log.actor_role === 'admin' ? 'Master Admin' : 'Legacy Agent')}</span><span data-label="Email" title={log.user_email || ''}>{log.user_email || '—'}</span><span data-label="Event">{log.event_type}</span><span data-label="Words">{log.question_word_count || 0}</span><span data-label="Input">{log.input_tokens || 0}</span><span data-label="Output">{log.output_tokens || 0}</span><span data-label="Model" title={log.model || ''}>{log.provider || '—'}{log.model ? ` · ${log.model}` : ''}</span><span data-label="Status" className={log.success ? 'good' : 'bad'}>{log.success ? 'Success' : 'Failed'}</span></div>)}{!pageLogs.length && <div className="empty-admin">No activity for this filter.</div>}</div>{totalPages > 1 && <div className="pager"><button disabled={activityPage === 1} onClick={() => setActivityPage((p) => Math.max(1, p - 1))}>‹ Prev</button>{pageNumbers.map((p, i) => p === '…' ? <span key={`e${i}`} className="pager-info">…</span> : <button key={p} className={p === activityPage ? 'current' : ''} onClick={() => setActivityPage(p)}>{p}</button>)}<button disabled={activityPage === totalPages} onClick={() => setActivityPage((p) => Math.min(totalPages, p + 1))}>Next ›</button></div>}</section></>}</div>}

        {tab === 'knowledge' && <div className="settings-stack">
          <section className="settings-card"><div className="settings-head"><div><h2>Product and Account catalogue</h2><p>Bird’s-eye view of the scopes detected from the current FAQ library. Previous models remain available to Agents; uncertain new detections stay in review instead of entering the live selector.</p></div><span className="state-pill ready">{knowledge?.scopeCatalog?.models?.length || 0} detected</span></div>
            <div className="scope-catalog-table">
              <div className="scope-catalog-head"><b>Product</b><b>Account model</b><b>Status</b><b>FAQ evidence</b></div>
              {(knowledge?.scopeCatalog?.models || []).map((model) => {
                const expanded = expandedScope === model.slug;
                const articles = model.articles || [];
                return <div className="scope-catalog-entry" key={model.slug}>
                  <div className="scope-catalog-row"><span>{model.product.toUpperCase()}</span><b>{model.name}{model.adminConfirmed && <small className="admin-confirmed">Admin confirmed</small>}</b><span className={`scope-status-badge ${model.status}`}>{model.status === 'current' ? 'Current' : model.status === 'previous' ? 'Not currently live' : 'Needs review'}</span><button type="button" className="scope-evidence-toggle" onClick={() => setExpandedScope(expanded ? null : model.slug)} aria-expanded={expanded}>{expanded ? 'Hide evidence' : `View ${model.articleCount} article${model.articleCount === 1 ? '' : 's'}`}<i>{expanded ? '−' : '+'}</i></button></div>
                  {expanded && <div className="scope-evidence-panel">
                    <div className="scope-status-actions"><span>Catalogue status</span><div>{[['current', 'Current'], ['previous', 'Not currently live'], ['review', 'Needs review']].map(([value, label]) => <button type="button" key={value} className={model.status === value ? 'selected' : ''} onClick={() => updateScopeStatus(model, value)}>{label}</button>)}</div></div>
                    <div className="scope-evidence-list">{articles.length ? articles.map((article, index) => {
                      const draft = articleScopeDraft(article, model);
                      const saved = savedArticleScope(article, model);
                      const dirty = draft.product !== saved.product || draft.model !== saved.model;
                      const modelOptions = (knowledge?.scopeCatalog?.models || []).filter((item) => item.product === draft.product && item.status !== 'review');
                      return <div className="article-scope-card" key={`${article.id || article.url || index}`}><a href={article.url || undefined} target={article.url ? '_blank' : undefined} rel={article.url ? 'noreferrer' : undefined}><span>{article.title || 'Untitled FAQ'}</span><em>{article.url ? 'Open article ↗' : 'Stored FAQ'}</em></a><div className="article-scope-editor"><label>Product<select value={draft.product} onChange={(event) => changeArticleScope(article, model, { product: event.target.value })}><option value="cfd">CFD</option><option value="futures">Futures</option></select></label><label>Availability<select value={draft.model} onChange={(event) => changeArticleScope(article, model, { model: event.target.value })}><option value="all">All {draft.product.toUpperCase()} models (product-wide)</option>{modelOptions.map((item) => <option key={item.slug} value={item.slug}>{item.name}{item.status === 'previous' ? ' — Not currently live' : ''}</option>)}</select></label><div className="article-scope-actions"><button type="button" className="btn-undo" disabled={!dirty || savingArticleScope === String(article.id)} onClick={() => undoArticleScope(article)}>↶ Undo</button><button type="button" className="btn-save-scope" disabled={!dirty || savingArticleScope === String(article.id)} onClick={() => saveArticleScope(article, model)}>{savingArticleScope === String(article.id) ? 'Saving…' : 'Save'}</button></div></div></div>;
                    }) : <p>No linked article details are available yet. Run a successful knowledge update to rebuild this evidence.</p>}</div>
                    {model.articleCount > articles.length && <small className="scope-evidence-note">Showing the first {articles.length} of {model.articleCount} matching articles.</small>}
                  </div>}
                </div>;
              })}
            </div>
            <p className="field-help">A new name needs repeated FAQ-title evidence before Agents can select it. One-off candidates remain visible here as “Needs review.” FNL:001 is treated as current.</p>
          </section>
          <section className="settings-card"><div className="settings-head"><div><h2>Article scope manager</h2><p>Correct the product and Account-model availability for any published FAQ. Edits remain local until that article’s Save button is pressed.</p></div><span className="state-pill ready">{knowledge?.articleScopes?.length || 0} articles</span></div><input className="admin-search" value={articleScopeSearch} onChange={(event) => setArticleScopeSearch(event.target.value)} placeholder="Search every published article…" /><div className="all-article-scopes">{filteredArticleScopes.map((article) => {
            const parent = { product: article.product, slug: article.model || 'all' };
            const draft = articleScopeDraft(article, parent);
            const saved = savedArticleScope(article, parent);
            const dirty = draft.product !== saved.product || draft.model !== saved.model;
            const options = (knowledge?.scopeCatalog?.models || []).filter((item) => item.product === draft.product && item.status !== 'review');
            return <div className="article-scope-card" key={article.id}><a href={article.url || undefined} target={article.url ? '_blank' : undefined} rel={article.url ? 'noreferrer' : undefined}><span>{article.title}</span><em>{article.overridden ? 'Admin assigned · Open ↗' : 'Detected · Open ↗'}</em></a><div className="article-scope-editor"><label>Product<select value={draft.product} onChange={(event) => changeArticleScope(article, parent, { product: event.target.value })}><option value="cfd">CFD</option><option value="futures">Futures</option></select></label><label>Availability<select value={draft.model} onChange={(event) => changeArticleScope(article, parent, { model: event.target.value })}><option value="all">All {draft.product.toUpperCase()} models (product-wide)</option>{options.map((item) => <option key={item.slug} value={item.slug}>{item.name}{item.status === 'previous' ? ' — Not currently live' : ''}</option>)}</select></label><div className="article-scope-actions"><button type="button" className="btn-undo" disabled={!dirty || savingArticleScope === String(article.id)} onClick={() => undoArticleScope(article)}>↶ Undo</button><button type="button" className="btn-save-scope" disabled={!dirty || savingArticleScope === String(article.id)} onClick={() => saveArticleScope(article, parent)}>{savingArticleScope === String(article.id) ? 'Saving…' : 'Save'}</button></div></div></div>;
          })}{!filteredArticleScopes.length && <div className="empty-admin">No published articles match this search.</div>}</div><p className="field-help">Showing up to 100 matching articles at a time. Search by the complete FAQ title to reach any article.</p></section>
          <section className="settings-card"><div className="settings-head"><div><h2>Chatbot knowledge</h2><p>Internal knowledge the chatbot can use alongside the Intercom FAQ — for example the trade calculator's formulas, instrument pip values, and account leverage. Turn documents on or off, edit them, then re-index to push changes into the chatbot.</p></div></div>
            <div className="autosync-grid">
              <div className="field-block"><label>Documents</label><b className="autosync-when">{knowledge?.docs?.length || 0} total · {knowledge?.docs?.filter((d) => d.enabled).length || 0} on</b></div>
              <div className="field-block"><label>Live in chatbot</label><b className="autosync-when">{knowledge?.indexedChunks || 0} searchable pieces</b></div>
              <div className="field-block"><label>Last re-index</label><b className="autosync-when">{knowledge?.indexedAt ? formatDate(knowledge.indexedAt) : 'Never'}</b></div>
              <div className="field-block"><label>&nbsp;</label><div className="autosync-actions" style={{ marginTop: 0 }}><button className="btn btn-primary" disabled={knowledgeBusy} onClick={reindexKnowledgeNow}>{knowledgeBusy ? 'Re-indexing…' : 'Re-index into chatbot'}</button></div></div>
            </div>
            <p className="field-help">Re-indexing embeds every enabled document so the assistant can retrieve and cite it. Run it after adding or editing documents. It does not touch your Intercom FAQ.</p>
            <div className="autosync-actions"><button className="btn btn-secondary" onClick={() => { setOpenDoc('new'); setDocDraft({ title: '', category: 'General', content: '', enabled: true }); }}>+ Add document</button></div>
          </section>

          {openDoc === 'new' && <section className="settings-card"><div className="settings-head"><div><h2>New document</h2></div></div>
            <div className="field-block"><label>Title</label><input value={docDraft?.title || ''} onChange={(e) => setDocDraft((d) => ({ ...d, title: e.target.value }))} placeholder="e.g. Payout methods and limits" /></div>
            <div className="field-block" style={{ marginTop: 12 }}><label>Category</label><input value={docDraft?.category || ''} onChange={(e) => setDocDraft((d) => ({ ...d, category: e.target.value }))} placeholder="e.g. Reference" /></div>
            <div className="field-block" style={{ marginTop: 12 }}><label>Content</label><textarea className="prompt-area" value={docDraft?.content || ''} onChange={(e) => setDocDraft((d) => ({ ...d, content: e.target.value }))} placeholder="Write the knowledge in plain language." /></div>
            <div className="autosync-actions"><button className="btn btn-primary" onClick={() => saveDoc(docDraft, 'Document added. Re-index to push it live.')}>Save document</button><button className="btn btn-secondary" onClick={() => { setOpenDoc(null); setDocDraft(null); }}>Cancel</button></div>
          </section>}

          <section className="settings-card"><div className="settings-head"><div><h2>Documents</h2><p>Click a document to view or edit it.</p></div></div>
            <div className="sync-log-list">{(knowledge?.docs || []).map((doc) => <div key={doc.id} className={`sync-log ${doc.enabled ? '' : 'skipped'}`}>
              <div className="sync-log-row" style={{ cursor: 'default' }}>
                <span className={`sync-badge ${doc.enabled ? 'success' : 'skipped'}`}>{doc.category}</span>
                <button className="sync-log-main" style={{ border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer', padding: 0 }} onClick={() => { const opening = openDoc !== doc.id; setOpenDoc(opening ? doc.id : null); setDocDraft(opening ? { id: doc.id, title: doc.title, category: doc.category, content: doc.content, enabled: doc.enabled } : null); }}><b>{doc.title}</b><small>{(doc.content || '').length} characters · updated {formatDate(doc.updated_at)}</small></button>
                <label className="toggle" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={!!doc.enabled} onChange={(e) => saveDoc({ id: doc.id, enabled: e.target.checked }, e.target.checked ? 'Document enabled. Re-index to apply.' : 'Document disabled. Re-index to apply.')} /><i /></label>
              </div>
              {openDoc === doc.id && <div className="sync-log-detail">
                <div className="field-block"><label>Title</label><input value={docDraft?.title || ''} onChange={(e) => setDocDraft((d) => ({ ...d, title: e.target.value }))} /></div>
                <div className="field-block" style={{ marginTop: 12 }}><label>Category</label><input value={docDraft?.category || ''} onChange={(e) => setDocDraft((d) => ({ ...d, category: e.target.value }))} /></div>
                <div className="field-block" style={{ marginTop: 12 }}><label>Content</label><textarea className="prompt-area" value={docDraft?.content || ''} onChange={(e) => setDocDraft((d) => ({ ...d, content: e.target.value }))} /></div>
                <div className="autosync-actions"><button className="btn btn-primary" onClick={() => saveDoc(docDraft, 'Document saved. Re-index to push changes live.')}>Save changes</button><button className="btn btn-danger" onClick={() => deleteDoc(doc.id)}>Delete</button></div>
              </div>}
            </div>)}{!knowledge?.docs?.length && <div className="empty-admin">No knowledge documents yet. Run the seed SQL, or use “Add document”.</div>}</div>
          </section>
        </div>}

        {tab === 'calcdata' && <div className="settings-stack">
          <section className="settings-card"><div className="settings-head"><div><h2>Instruments</h2><p>The exact values the trade calculator uses for each instrument. Edits are stored in Supabase and used immediately (built-in values are the fallback). Fix things like crypto sample prices here.</p></div></div>
            <div className="field-block"><label>Search</label><input value={calcSearch} onChange={(e) => setCalcSearch(e.target.value)} placeholder="e.g. XAUUSD, BTC, EURJPY" /></div>
            <div className="sync-log-list" style={{ marginTop: 12 }}>{(calc?.instruments || []).filter((i) => !calcSearch || i.symbol.includes(calcSearch.toUpperCase())).slice(0, 80).map((i) => <div key={i.symbol} className="sync-log">
              <div className="sync-log-row" style={{ cursor: 'default' }}>
                <span className="sync-badge success">{i.marketType}</span>
                <button className="sync-log-main" style={{ border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer', padding: 0 }} onClick={() => { const opening = openInst !== i.symbol; setOpenInst(opening ? i.symbol : null); setInstDraft(opening ? { ...i } : null); }}><b>{i.symbol}</b><small>pip value ${i.pipValue} · pip size {i.pipSize} · contract {i.contractSize} · sample {i.samplePrice == null ? '—' : i.samplePrice}</small></button>
                <span className="sync-chevron">{openInst === i.symbol ? '▴' : '▾'}</span>
              </div>
              {openInst === i.symbol && <div className="sync-log-detail"><div className="autosync-grid">
                <div className="field-block"><label>Pip value ($/lot)</label><input value={instDraft?.pipValue ?? ''} onChange={(e) => setInstDraft((d) => ({ ...d, pipValue: e.target.value }))} /></div>
                <div className="field-block"><label>Pip size</label><input value={instDraft?.pipSize ?? ''} onChange={(e) => setInstDraft((d) => ({ ...d, pipSize: e.target.value }))} /></div>
                <div className="field-block"><label>Contract size</label><input value={instDraft?.contractSize ?? ''} onChange={(e) => setInstDraft((d) => ({ ...d, contractSize: e.target.value }))} /></div>
                <div className="field-block"><label>Conversion factor</label><input value={instDraft?.conversionFactor ?? ''} onChange={(e) => setInstDraft((d) => ({ ...d, conversionFactor: e.target.value }))} /></div>
                <div className="field-block"><label>Sample price (example entry)</label><input value={instDraft?.samplePrice ?? ''} onChange={(e) => setInstDraft((d) => ({ ...d, samplePrice: e.target.value }))} /></div>
                <div className="field-block"><label>Market type</label><select value={instDraft?.marketType || 'Currency'} onChange={(e) => setInstDraft((d) => ({ ...d, marketType: e.target.value }))}>{['Currency', 'Commodity', 'Indice', 'Crypto'].map((m) => <option key={m} value={m}>{m}</option>)}</select></div>
              </div><div className="autosync-actions"><button className="btn btn-primary" onClick={() => saveInstrument(instDraft, `${i.symbol} updated.`)}>Save {i.symbol}</button></div></div>}
            </div>)}{calc && !calc.instruments.length && <div className="empty-admin">No instruments found. Run the calculator-data SQL to seed them.</div>}</div>
          </section>

          <section className="settings-card"><div className="settings-head"><div><h2>Account leverage</h2><p>Leverage per account type and market. Add a row here to define a new account (for example Stellar Instant) so the calculator can size margin and max lot for it.</p></div></div>
            <div className="sync-log-list">{(calc?.leverage || []).map((r) => <div key={`${r.stepKey}-${r.marketType}-${r.phase}`} className="sync-log"><div className="sync-log-row" style={{ cursor: 'default' }}>
              <span className="sync-badge success">{r.marketType}</span>
              <span className="sync-log-main"><b>{r.stepKey} · {r.phase}</b><small>Leverage 1:{r.leverage}</small></span>
              <input style={{ width: 84 }} defaultValue={r.leverage} onBlur={(e) => { const v = Number(e.target.value); if (v && v !== r.leverage) saveLeverage({ stepKey: r.stepKey, marketType: r.marketType, phase: r.phase, leverage: v }, 'Leverage updated.'); }} />
              <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => removeLeverage({ stepKey: r.stepKey, marketType: r.marketType, phase: r.phase })}>Remove</button>
            </div></div>)}{calc && !calc.leverage.length && <div className="empty-admin">No leverage rows. Run the calculator-data SQL to seed them.</div>}</div>
            <div className="autosync-grid" style={{ marginTop: 14 }}>
              <div className="field-block"><label>Account key</label><input value={newLev.stepKey} onChange={(e) => setNewLev((d) => ({ ...d, stepKey: e.target.value }))} placeholder="e.g. instant" /></div>
              <div className="field-block"><label>Market</label><select value={newLev.marketType} onChange={(e) => setNewLev((d) => ({ ...d, marketType: e.target.value }))}>{['Currency', 'Commodity', 'Indice', 'Crypto'].map((m) => <option key={m} value={m}>{m}</option>)}</select></div>
              <div className="field-block"><label>Phase</label><select value={newLev.phase} onChange={(e) => setNewLev((d) => ({ ...d, phase: e.target.value }))}>{['any', 'challenge', 'fundednext'].map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
              <div className="field-block"><label>Leverage (1:x)</label><input value={newLev.leverage} onChange={(e) => setNewLev((d) => ({ ...d, leverage: e.target.value }))} placeholder="e.g. 30" /></div>
            </div>
            <div className="autosync-actions"><button className="btn btn-primary" onClick={() => { if (!newLev.stepKey || !newLev.leverage) return setError('Enter an account key and leverage.'); saveLeverage(newLev, 'Leverage row added.'); setNewLev({ stepKey: '', marketType: 'Currency', phase: 'any', leverage: '' }); }}>Add leverage row</button></div>
            <p className="field-help">The account key is matched from the customer's wording — use "instant" for Stellar Instant, "1-step", "2-step", "lite". Use phase "any" when Challenge and Funded share the same leverage.</p>
          </section>
        </div>}

        {tab === 'groqkeys' && <div className="settings-stack">
          <section className="settings-card"><div className="settings-head"><div><h2>Groq key pool</h2><p>Add multiple free Groq keys and the app rotates across them for every answer, spreading the rate limit so many agents can work at once. Keys are stored encrypted and never shown again after saving.</p></div>{groqKeys?.length ? <span className="state-pill ready">{groqKeys.filter((k) => k.active).length} active</span> : null}</div>
            <div className="sync-log-list">{(groqKeys || []).map((k) => <div key={k.id} className={`sync-log ${k.active ? '' : 'skipped'}`}><div className="sync-log-row" style={{ cursor: 'default' }}>
              <span className={`sync-badge ${k.active ? 'success' : 'skipped'}`}>{k.active ? 'Active' : 'Off'}</span>
              <span className="sync-log-main"><b>{k.label}</b><small>Added {formatDate(k.created_at)}</small></span>
              <label className="toggle" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={!!k.active} onChange={(e) => groqKeyAction({ id: k.id, active: e.target.checked }, 'POST', e.target.checked ? 'Key enabled.' : 'Key disabled.')} /><i /></label>
              <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={() => { if (window.confirm('Delete this Groq key?')) groqKeyAction({ id: k.id }, 'DELETE', 'Key deleted.'); }}>Delete</button>
            </div></div>)}{groqKeys && !groqKeys.length && <div className="empty-admin">No Groq keys yet. Add one below. (Run the groq-keys SQL first.)</div>}</div>
            <div className="autosync-grid" style={{ marginTop: 14 }}>
              <div className="field-block"><label>Label (for you)</label><input value={newGroqKey.label} onChange={(e) => setNewGroqKey((d) => ({ ...d, label: e.target.value }))} placeholder="e.g. Agent Momen's key" /></div>
              <div className="field-block"><label>Groq API key</label><input type="password" value={newGroqKey.key} onChange={(e) => setNewGroqKey((d) => ({ ...d, key: e.target.value }))} placeholder="gsk_…" /></div>
            </div>
            <div className="autosync-actions"><button className="btn btn-primary" onClick={() => { if (!newGroqKey.key.trim()) return setError('Paste a Groq key first.'); groqKeyAction(newGroqKey, 'POST', 'Groq key added.'); setNewGroqKey({ label: '', key: '' }); }}>Add key</button></div>
            <p className="field-help">Rotation is automatic and random so concurrent users spread evenly. If one key is rate-limited mid-answer, the app instantly tries the next active key. This works when the answering provider is set to Groq.</p>
          </section>
        </div>}

        {tab === 'autosync' && <div className="settings-stack">
          <section className="settings-card"><div className="settings-head"><div><h2>Automatic FAQ sync</h2><p>Keep the knowledge base current on its own. When on, the app checks Intercom for new or changed articles on the schedule you choose and re-indexes what changed.</p></div><label className="toggle big"><input type="checkbox" checked={!!autoSync?.enabled} onChange={(e) => saveAutoSync({ enabled: e.target.checked }, e.target.checked ? 'Automatic sync turned on.' : 'Automatic sync turned off.')} /><i /></label></div>
            <div className="autosync-grid">
              <div className="field-block"><label>Run every</label><select value={autoSync?.intervalHours || 6} disabled={!autoSync?.enabled} onChange={(e) => saveAutoSync({ intervalHours: Number(e.target.value) }, 'Sync schedule updated.')}>{(autoSync?.intervalOptions || [2, 3, 4, 6, 8, 12, 24]).map((h) => <option key={h} value={h}>{h === 24 ? 'Every 24 hours (daily)' : `Every ${h} hours`}</option>)}</select></div>
              <div className="field-block"><label>Status</label><div className={`autosync-state ${autoSync?.enabled ? 'on' : 'off'}`}><span className="live-dot" />{autoSync?.enabled ? `On · every ${autoSync?.intervalHours || 6}h` : 'Off'}</div></div>
              <div className="field-block"><label>Last successful sync</label><b className="autosync-when">{autoSync?.lastAutoSyncAt ? formatDate(autoSync.lastAutoSyncAt) : 'Never run yet'}</b></div>
              <div className="field-block"><label>Waiting to index</label><b className="autosync-when">{autoSync?.queued ? `${autoSync.queued} article${autoSync.queued === 1 ? '' : 's'}` : 'Nothing queued'}</b></div>
            </div>
            <div className="autosync-actions"><button className="btn btn-primary" disabled={runningSync} onClick={runAutoSyncNow}>{runningSync ? 'Syncing…' : 'Run sync now'}</button><button className="btn btn-secondary" disabled={runningSync} onClick={loadAutoSync}>Refresh</button></div>
            <p className="field-help">“Run sync now” works even when automatic sync is off. A long sync continues across later scheduled runs.</p>
            {autoSync && !autoSync.schedulerReady && <div className="sync-error"><span>Scheduled sync needs one Vercel setting</span><p>{autoSync.schedulerMessage}</p></div>}
          </section>

          <section className="settings-card"><div className="settings-head"><div><h2>Sync history</h2><p>Every automatic and manual run, newest first. Open a row for full details.</p></div>{autoSync?.logs?.length ? <span className="state-pill ready">{autoSync.logs.length} recorded</span> : null}</div>
            <div className="sync-log-list">{(autoSync?.logs || []).map((log) => <div key={log.id} className={`sync-log ${log.status}`}>
              <button className="sync-log-row" onClick={() => setExpandedSync(expandedSync === log.id ? null : log.id)}>
                <span className={`sync-badge ${log.status}`}>{syncStatusLabel(log.status)}</span>
                <span className="sync-log-main"><b>{log.trigger === 'manual' ? 'Manual run' : 'Automatic run'}</b><small>{formatDate(log.started_at)}</small></span>
                <span className="sync-log-quick">{log.status === 'failed' ? 'See reason' : `${log.articles_changed || 0} changed · ${log.articles_indexed || 0} indexed`}</span>
                <span className="sync-chevron">{expandedSync === log.id ? '▴' : '▾'}</span>
              </button>
              {expandedSync === log.id && <div className="sync-log-detail">
                <div className="sync-detail-grid">
                  <div><span>Started</span><b>{formatDate(log.started_at)}</b></div>
                  <div><span>Finished</span><b>{log.finished_at ? formatDate(log.finished_at) : '—'}</b></div>
                  <div><span>Duration</span><b>{formatDuration(log.duration_ms)}</b></div>
                  <div><span>Trigger</span><b>{log.trigger === 'manual' ? 'Manual' : 'Automatic'}</b></div>
                  <div><span>Articles scanned</span><b>{log.articles_scanned ?? 0}</b></div>
                  <div><span>Changed / new</span><b>{log.articles_changed ?? 0}</b></div>
                  <div><span>Re-indexed</span><b>{log.articles_indexed ?? 0}</b></div>
                  <div><span>Removed</span><b>{log.articles_deleted ?? 0}</b></div>
                  <div><span>Searchable pieces written</span><b>{log.chunks_written ?? 0}</b></div>
                  <div><span>Processing passes</span><b>{log.steps ?? 0}</b></div>
                </div>
                {log.error && <div className="sync-error"><span>Failure reason</span><p>{log.error}</p></div>}
                {Array.isArray(log.sample_titles) && log.sample_titles.length > 0 && <div className="sync-samples"><span>Updated articles included</span><div className="sync-chips">{log.sample_titles.map((title, i) => <em key={i}>{title}</em>)}</div></div>}
              </div>}
            </div>)}{!autoSync?.logs?.length && <div className="empty-admin">No sync runs recorded yet. Press “Run sync now” or wait for the first automatic run.</div>}</div>
          </section>
        </div>}

        {tab === 'keys' && <div className="settings-stack"><section className="settings-card"><div className="settings-head"><div><h2>Encrypted API keys</h2><p>Keys are encrypted before storage and never displayed again.</p></div></div>{[['Intercom API key',intercom,setIntercom,status?.intercomSet],['OpenAI API key',openai,setOpenai,status?.openaiSet],['Groq API key',groq,setGroq,status?.groqSet]].map(([label,value,setter,isSet]) => <div className="vault-field" key={label}><div><label>{label}</label><span className={`state-pill ${isSet ? 'ready' : ''}`}>{isSet ? 'Connected' : 'Not set'}</span></div><input type="password" value={value} onChange={(e) => setter(e.target.value)} placeholder="Paste to set or replace" /></div>)}<button className="btn btn-primary" disabled={saving} onClick={async () => { const body = {}; if (intercom.trim()) body.intercomToken = intercom.trim(); if (openai.trim()) body.openaiKey = openai.trim(); if (groq.trim()) body.groqKey = groq.trim(); if (await settingsSave(body, 'API keys saved securely.')) { setIntercom(''); setOpenai(''); setGroq(''); } }}>Save API keys</button></section></div>}
      </section>
    </main>
  );
}
