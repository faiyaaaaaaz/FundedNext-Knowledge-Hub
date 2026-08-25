import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { getSupabaseBrowser } from '../lib/supabaseBrowser';

const THINKING_STEPS = [
  'Reading your question',
  'Searching the verified FAQ library',
  'Matching the exact Account and product rules',
  'Applying FundedNext brand language',
  'Scoring the source confidence',
  'Writing a client-ready reply'
];

/* Theme-aware FN mark — letters inherit the ink colour, triangle stays violet. */
function Logo({ className = '' }) {
  return (
    <svg className={`fn-logo ${className}`} viewBox="12 15 41 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path className="fn-letters" d="M15 19h13v5.4h-7.4v4.1H27v5.3h-6.4V45H15z" />
      <path className="fn-letters" d="M31 19h5.1l9 12.4V19h5.6v26h-5.1l-9-12.3V45H31z" />
      <path className="fn-tri" d="M41.4 19H50.7v9.3z" />
    </svg>
  );
}

function GoogleG() {
  return (
    <svg className="google-mark" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
      <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
    </svg>
  );
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><Logo /></span><div><b>FundedNext</b><span>Support Assistant</span></div></div>;
}

/* Normalise exotic Unicode spaces to plain spaces so pasted text is clean. */
function normalizeSpaces(text) {
  return String(text || '').replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u2060\u3000\uFEFF]/g, ' ');
}

function plainText(text) {
  return normalizeSpaces(text)
    .replace(/(\d)\s*\*\s*(?=\d)/g, '$1 × ')
    .replace(/[ \t]\*[ \t]/g, ' × ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\s*\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/g, '')
    .replace(/[*_]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function renderBlocks(text) {
  const blocks = [];
  let list = [];
  let listType = '';
  const flush = () => {
    if (!list.length) return;
    const Tag = listType === 'number' ? 'ol' : 'ul';
    blocks.push(<Tag key={`list-${blocks.length}`}>{list.map((item, index) => <li key={index}>{plainText(item)}</li>)}</Tag>);
    list = []; listType = '';
  };
  normalizeSpaces(text).split('\n').forEach((raw) => {
    const line = raw.trim();
    if (!line) return flush();
    const bullet = line.match(/^[-*•]\s+(.*)/);
    const numbered = line.match(/^\d+[.)]\s+(.*)/);
    if (bullet || numbered) {
      const type = numbered ? 'number' : 'bullet';
      if (listType && listType !== type) flush();
      listType = type; list.push((bullet || numbered)[1]); return;
    }
    flush();
    blocks.push(<p key={`p-${blocks.length}`}>{plainText(line)}</p>);
  });
  flush();
  return blocks;
}

function Answer({ text }) {
  return <div className="answer">{renderBlocks(text)}</div>;
}

// Small numbered citation chips shown at the end of a paragraph. The visible
// number is drawn with CSS (content: attr(data-n)) and everything here is
// user-select:none, so citations are NEVER included when text is copied or
// manually selected. Hover or tap reveals the source; click opens the article.
function SourceCites({ refs, sources }) {
  return (
    <span className="seg-cites" aria-hidden={false}>
      {refs.map((n) => {
        const source = sources?.[n - 1];
        if (!source) return null;
        return (
          <a key={n} className={`seg-cite${source.kind === 'calculator' ? ' calc' : ''}`} data-n={n} href={source.url || undefined} target="_blank" rel="noreferrer"
            aria-label={`${source.kind === 'calculator' ? 'Calculator reference' : 'Source'} ${n}: ${source.title}`}>
            <span className="seg-cite-pop" aria-hidden="true">
              <b>{source.kind === 'calculator' ? '⚙ Calculator' : `Source ${n}`}</b><span>{source.title}</span><em>{source.kind === 'calculator' ? 'Reference' : 'Open article ↗'}</em>
            </span>
          </a>
        );
      })}
    </span>
  );
}

function AttributedAnswer({ segments, sources }) {
  return (
    <div className="answer">
      {segments.map((seg, i) => {
        const blocks = renderBlocks(seg.text);
        if (seg.refs?.length && blocks.length) {
          const last = blocks[blocks.length - 1];
          const cites = <SourceCites key="cites" refs={seg.refs} sources={sources} />;
          if (last.type === 'p') {
            blocks[blocks.length - 1] = <p key={last.key}>{last.props.children}{cites}</p>;
          } else {
            blocks.push(<p key={`cites-${i}`} className="cites-row">{cites}</p>);
          }
        }
        return <div className="answer-seg" key={i}>{blocks}</div>;
      })}
    </div>
  );
}

function formatDhaka(value) {
  if (!value) return 'Not available';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  }).format(new Date(value)) + ' GMT+6';
}

function timeAgo(value) {
  if (!value) return '';
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function confidenceTone(score) {
  if (score >= 85) return 'high';
  if (score >= 65) return 'medium';
  return 'low';
}

function ConfidenceHealth({ score, label, reasons = [] }) {
  const tone = confidenceTone(score);
  const items = reasons.length ? reasons : [{ label: 'Based on applicable FAQ evidence and grounding checks', impact: 'neutral' }];
  return <span className={`confidence-health ${tone}`} tabIndex="0" aria-label={`${score}% ${label}`}><span className="confidence-copy"><b>{score}%</b><small>{label}</small></span><span className="confidence-track"><i style={{ width: `${Math.max(3, score)}%` }} /></span><span className="confidence-info">i</span><span className="confidence-tooltip" role="tooltip"><b>Why this confidence?</b>{items.map((reason, index) => <span key={`${reason.code || 'reason'}-${index}`}><i className={reason.impact || 'neutral'} />{reason.label}</span>)}</span></span>;
}

function ScopeSelect({ label, value, groups, onChange, className = '' }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const options = groups.flatMap((group) => group.options);
  const selected = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 10;
      const below = window.innerHeight - rect.bottom - margin;
      const above = rect.top - margin;
      const placeAbove = below < 240 && above > below;
      const maxHeight = Math.max(160, Math.min(420, (placeAbove ? above : below) - 8));
      setPlacement({
        position: 'fixed', left: Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin)),
        width: rect.width, maxHeight,
        ...(placeAbove ? { bottom: window.innerHeight - rect.top + 7 } : { top: Math.min(window.innerHeight - margin, rect.bottom + 7) }),
        zIndex: 10000
      });
    };
    const outside = (event) => {
      if (!triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    document.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);

  return <div className={`app-select ${className}`}><span className="app-select-label">{label}</span><button ref={triggerRef} type="button" className={open ? 'open' : ''} onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open}><span><b>{selected?.label}</b>{selected?.description && <small>{selected.description}</small>}</span><i>⌄</i></button>{open && placement && createPortal(<div ref={menuRef} className="app-select-menu" style={placement} role="listbox">{groups.map((group) => <div className="app-select-group" key={group.label || 'options'}>{group.label && <div className="app-select-group-label">{group.label}</div>}{group.options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'selected' : ''} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}><span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>{option.badge && <em className={option.badgeTone || ''}>{option.badge}</em>}{option.value === value && <i>✓</i>}</button>)}</div>)}</div>, document.body)}</div>;
}

export default function Home() {
  const [session, setSession] = useState('');
  const [role, setRole] = useState('');
  const [identity, setIdentity] = useState({ name: '', email: '' });
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [theme, setTheme] = useState('dark');
  const [scopeCatalog, setScopeCatalog] = useState({ products: [], models: [] });
  const [scopeProduct, setScopeProduct] = useState('cfd');
  const [scopeModel, setScopeModel] = useState('all');
  const [savedScope, setSavedScope] = useState({ product: 'cfd', model: 'all' });
  const [scopeNotice, setScopeNotice] = useState(null);
  const [clarification, setClarification] = useState(null);
  const [clarificationOther, setClarificationOther] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [thinkingStep, setThinkingStep] = useState(0);
  const [openSources, setOpenSources] = useState({});
  const [copied, setCopied] = useState(null);
  const [stats, setStats] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncState, setSyncState] = useState({ headline: 'Knowledge base', details: [] });
  const [elapsed, setElapsed] = useState(0);
  const [disputeIndex, setDisputeIndex] = useState(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeError, setDisputeError] = useState('');
  const [submittingDispute, setSubmittingDispute] = useState(false);
  const threadRef = useRef(null);
  const timerRef = useRef(null);
  const cancelRef = useRef(false);
  const abortRef = useRef(null);
  const thinkingRef = useRef(null);

  useEffect(() => {
    const savedSession = localStorage.getItem('appSession') || '';
    const savedRole = localStorage.getItem('appRole') || '';
    if (savedSession) {
      setSession(savedSession); setRole(savedRole);
      setIdentity({ name: localStorage.getItem('appName') || '', email: localStorage.getItem('appEmail') || '' });
      loadStats(savedSession); loadScopes(savedSession);
    } else completeGoogleLogin();
    const savedTheme = localStorage.getItem('theme') || 'dark';
    setTheme(savedTheme); document.documentElement.setAttribute('data-theme', savedTheme);
    return () => { timerRef.current && clearInterval(timerRef.current); thinkingRef.current && clearInterval(thinkingRef.current); };
  }, []);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, loading]);

  function headers(token = session, json = false) {
    return { ...(json ? { 'Content-Type': 'application/json' } : {}), 'x-app-session': token };
  }

  async function loadStats(token = session) {
    if (!token) return;
    try {
      const response = await fetch('/api/stats', { headers: { 'x-app-session': token } });
      if (response.status === 401) return logout();
      if (response.ok) setStats(await response.json());
    } catch {}
  }

  async function loadScopes(token = session) {
    if (!token) return;
    try {
      const response = await fetch('/api/scopes', { headers: { 'x-app-session': token } });
      if (!response.ok) return;
      const data = await response.json();
      setScopeCatalog(data.catalog || { products: [], models: [] });
      setScopeProduct(data.preference?.product || 'cfd');
      setScopeModel(data.selectedExists === false ? 'all' : (data.preference?.model || 'all'));
      setSavedScope({ product: data.preference?.product || 'cfd', model: data.selectedExists === false ? 'all' : (data.preference?.model || 'all') });
      if (data.selectedExists === false) setScopeNotice({ title: 'Your previous Account model is no longer verified', text: 'The selection was reset to all models. Choose a verified model before asking a model-specific question.' });
    } catch {}
  }

  async function saveScope(product, model = 'all') {
    setScopeProduct(product); setScopeModel(model); setScopeNotice(null);
  }

  async function saveDefaultScope() {
    try {
      const response = await fetch('/api/scopes', { method: 'POST', headers: headers(session, true), body: JSON.stringify({ product: scopeProduct, model: scopeModel }) });
      if (!response.ok) throw new Error('Could not save this default.');
      setSavedScope({ product: scopeProduct, model: scopeModel });
    } catch {}
  }

  function storeLogin(data) {
    localStorage.setItem('appSession', data.token); localStorage.setItem('appRole', data.role);
    localStorage.setItem('appName', data.name || ''); localStorage.setItem('appEmail', data.email || '');
    setSession(data.token); setRole(data.role); setIdentity({ name: data.name || '', email: data.email || '' });
    loadStats(data.token); loadScopes(data.token);
  }

  async function completeGoogleLogin() {
    const client = getSupabaseBrowser();
    if (!client) return;
    setLoggingIn(true);
    try {
      const { data } = await client.auth.getSession();
      if (!data.session?.access_token) return;
      const response = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ googleAccessToken: data.session.access_token }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Google sign-in was not accepted.');
      storeLogin(result);
    } catch (error) { setLoginError(error.message); } finally { setLoggingIn(false); }
  }

  async function googleLogin() {
    const client = getSupabaseBrowser();
    if (!client) return setLoginError('Google sign-in is not configured yet. Ask an Admin to finish setup.');
    setLoginError('');
    const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
    if (error) setLoginError(error.message);
  }

  function logout() {
    localStorage.removeItem('appSession'); localStorage.removeItem('appRole'); localStorage.removeItem('appPw');
    localStorage.removeItem('appName'); localStorage.removeItem('appEmail');
    getSupabaseBrowser()?.auth.signOut().catch(() => {});
    setSession(''); setRole(''); setIdentity({ name: '', email: '' }); setMessages([]); setStats(null);
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next); localStorage.setItem('theme', next); document.documentElement.setAttribute('data-theme', next);
  }

  async function send(question = input.trim(), clarificationAnswer = '', showUser = true) {
    const value = String(question).trim();
    if (!value || loading) return;
    const questionId = `${Date.now()}-${Math.random()}`;
    if (showUser) setMessages((current) => [...current, { role: 'user', content: value, questionId }]);
    setScopeNotice(null);
    setInput(''); setLoading(true); setThinkingStep(0);
    thinkingRef.current = setInterval(() => setThinkingStep((current) => Math.min(current + 1, THINKING_STEPS.length - 1)), 1300);
    try {
      const response = await fetch('/api/search', { method: 'POST', headers: headers(session, true), body: JSON.stringify({ question: value, clarification: clarificationAnswer || undefined, scope: { product: scopeProduct, model: scopeModel } }) });
      const data = await response.json();
      if (response.status === 401) { logout(); throw new Error('Your session ended. Please sign in again.'); }
      if (!response.ok) throw new Error(data.error || 'The assistant could not answer.');
      if (data.needsClarification) {
        setClarification({ originalQuestion: data.originalQuestion || value, question: data.clarifyingQuestion, reason: data.clarificationReason, choices: data.choices || [] });
        setClarificationOther('');
        return;
      }
      if (data.scopeNotice) {
        setScopeNotice({ title: data.noticeTitle, text: data.notice });
        return;
      }
      setMessages((current) => [...current, {
        role: 'assistant', question: value, questionId, content: data.answer,
        sources: data.sources || [], segments: data.segments || null,
        usedCalculator: !!data.usedCalculator,
        provider: data.answerProvider, fallback: data.usedFallback,
        confidence: data.confidence, confidenceLabel: data.confidenceLabel, confidenceReasons: data.confidenceReasons || [], disputed: false
      }]);
      setScopeProduct(savedScope.product);
      setScopeModel(savedScope.model);
    } catch (error) {
      setMessages((current) => [...current, { role: 'assistant', question: value, questionId, content: error.message, sources: [], error: true }]);
    } finally { clearInterval(thinkingRef.current); setLoading(false); loadStats(); }
  }

  function answerClarification(answer) {
    const choice = String(answer?.value || answer || '').trim();
    if (!clarification || !choice || loading) return;
    const original = clarification.originalQuestion;
    setMessages((current) => [...current, { role: 'user', content: `Clarification: ${choice}`, clarification: true }]);
    setClarification(null); setClarificationOther('');
    send(`${original}\n\nUser clarification: ${choice}`, choice, false);
  }

  async function copyAnswer(index, text) {
    await navigator.clipboard.writeText(plainText(text));
    setCopied(index); setTimeout(() => setCopied(null), 1800);
  }

  async function submitDispute() {
    const message = messages[disputeIndex];
    if (!message) return;
    if (disputeReason.trim().length < 10) return setDisputeError('Please explain what is wrong in at least 10 characters.');
    setSubmittingDispute(true); setDisputeError('');
    try {
      const response = await fetch('/api/disputes', {
        method: 'POST', headers: headers(session, true),
        body: JSON.stringify({
          question: message.question, answer: message.content, reason: disputeReason.trim(),
          confidence: message.confidence, provider: message.provider, sources: message.sources
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not submit the dispute.');
      setMessages((current) => current.map((item, index) =>
        index === disputeIndex ? { ...item, disputed: true, disputeId: data.dispute.id } : item
      ));
      setDisputeIndex(null); setDisputeReason('');
    } catch (error) { setDisputeError(error.message); } finally { setSubmittingDispute(false); }
  }

  async function checkUpdates() {
    setSyncing(true); setSyncOpen(true); cancelRef.current = false; setElapsed(0);
    const started = Date.now();
    let processed = 0, chunks = 0, batches = 0, failures = 0, changedDetectionPasses = 0;
    const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setSyncState({ headline: 'Inspecting the saved sync queue', details: [`Started at ${clock()}`, 'No article comparison has run yet'] });
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    try {
      for (;;) {
        if (cancelRef.current) {
          setSyncState((current) => ({ headline: 'Sync paused — progress saved', details: [...current.details, 'You can resume any time with Check for updates'] }));
          break;
        }
        const statusResponse = await fetch('/api/sync', { method: 'POST', headers: headers(session, true), body: JSON.stringify({ action: 'status' }) });
        const status = await statusResponse.json();
        if (statusResponse.status === 401) { logout(); break; }
        if (!statusResponse.ok) throw new Error(status.error || 'Could not inspect the sync queue.');
        const activePhase = status.phase;
        setSyncState(activePhase === 'detecting' ? {
          headline: 'Comparing Intercom with the saved knowledge base',
          details: [
            `Comparison started at ${clock()}`,
            'Saved queue confirmed empty',
            'Fetching every published article and comparing its ID and content fingerprint'
          ]
        } : {
          headline: `Indexing ${status.queued} previously detected article change${status.queued === 1 ? '' : 's'}`,
          details: [
            `Batch started at ${clock()}`,
            `${status.queued} article${status.queued === 1 ? '' : 's'} already waiting in the saved queue`,
            'Creating searchable sections and embeddings for this batch'
          ]
        });

        const controller = new AbortController(); abortRef.current = controller;
        const timeout = setTimeout(() => controller.abort(), 55000);
        const progressNotice = setTimeout(() => setSyncState((current) => ({
          headline: activePhase === 'detecting' ? 'Comparison is still scanning all article pages' : 'This indexing batch is still being processed',
          details: [...current.details.slice(0, 3), `No result has returned yet · ${clock()}`]
        })), 15000);
        try {
          const response = await fetch('/api/sync', { method: 'POST', headers: headers(session, true), body: '{}', signal: controller.signal });
          clearTimeout(timeout); clearTimeout(progressNotice);
          const data = await response.json();
          if (response.status === 401) { logout(); break; }
          if (!response.ok) throw new Error(data.error || `Server ${response.status}`);
          failures = 0; processed += data.processed || 0; chunks += data.chunkCount || 0; batches += data.embeddingBatches || 0;
          loadStats();
          const detail = data.phase === 'detecting'
            ? [
                `Comparison completed at ${clock()}`,
                `${data.scanned || 0} published Intercom articles compared`,
                `New articles: ${data.newFound || 0} · Changed existing articles: ${data.updatedFound || 0} · Removed articles: ${data.deleted || 0}`,
                data.comparisonConfirmed ? 'Final verification confirmed zero differences' : `${data.changedFound || 0} total difference${data.changedFound === 1 ? '' : 's'} added to the saved queue`
              ]
            : [
                `Batch completed at ${clock()}`,
                `${processed} queued article${processed === 1 ? '' : 's'} indexed during this run`,
                `${chunks} searchable section${chunks === 1 ? '' : 's'} saved · ${batches} embedding batch${batches === 1 ? '' : 'es'} completed`,
                `${data.remaining || 0} article${data.remaining === 1 ? '' : 's'} remain in the saved queue`,
                ...(data.sampleTitles?.length ? [`Last completed batch: ${data.sampleTitles.join(' · ')}`] : [])
              ];
          if (data.phase === 'detecting' && data.changedFound > 0) {
            changedDetectionPasses++;
            if (changedDetectionPasses > 1) {
              setSyncState({ headline: 'Verification stopped: the same run detected another difference set', details: [...detail, 'Nothing is being labelled fully up to date. Review the sync history before retrying.'] });
              break;
            }
          }
          setSyncState({
            headline: data.done
              ? 'Verified up to date — zero differences found'
              : data.phase === 'detecting'
                ? `${data.changedFound || 0} difference${data.changedFound === 1 ? '' : 's'} detected and queued`
                : data.verificationRequired
                  ? 'Indexing finished — starting final verification'
                  : `Indexing saved changes — ${data.remaining} article${data.remaining === 1 ? '' : 's'} remaining`,
            details: detail
          });
          if (data.done) break;
        } catch (error) {
          clearTimeout(timeout); clearTimeout(progressNotice); if (cancelRef.current) continue;
          // Aborting the browser request does not guarantee the serverless
          // function stopped. Never launch a duplicate indexing request while
          // the first one may still be committing its batch.
          if (error?.name === 'AbortError') {
            setSyncState({ headline: 'Stopped waiting without starting a duplicate request', details: ['The request did not return within 55 seconds', 'The server may still finish the current saved batch', 'Wait one minute, then press Check for updates to inspect the real queue state'] });
            break;
          }
          failures++;
          if (failures > 2) { setSyncState({ headline: 'Sync stopped without claiming completion', details: ['Completed batches remain saved', `${activePhase === 'detecting' ? 'Comparison' : 'Indexing'} failed twice`, error?.message || 'The request failed'] }); break; }
          setSyncState({ headline: `Retrying ${activePhase === 'detecting' ? 'the comparison' : 'this indexing batch'} · ${failures} of 2`, details: ['Completed batches remain saved', error?.message || 'The request failed', `Retry scheduled at ${clock()}`] });
          await new Promise((resolve) => setTimeout(resolve, 1500 * failures));
        }
      }
    } catch (error) {
      setSyncState({ headline: 'Sync stopped before article processing', details: ['No completion claim was recorded', error?.message || 'The saved queue could not be inspected', `Stopped at ${clock()}`] });
    } finally {
      clearInterval(timerRef.current); setSyncing(false); loadStats();
    }
  }

  if (!session) return (
    <main className="login-page"><section className="login-panel"><div className="login-glow" /><Brand />
      <div className="login-copy"><span className="status-chip">Internal knowledge workspace</span><h1>Answers your team can trust.</h1><p>Clear, source-backed support answers for every FundedNext client conversation.</p></div>
      <div className="login-form"><button className="google-button" onClick={googleLogin} disabled={loggingIn}><GoogleG />{loggingIn ? 'Finishing sign-in…' : 'Continue with Google'}</button>{loginError && <div className="inline-error">{loginError}</div>}<p className="field-help" style={{ textAlign: 'center' }}>Only nextventures.io Google accounts are permitted.</p></div>
      <div className="login-foot">For authorized FundedNext team members only</div>
    </section></main>
  );

  const availableModels = (scopeCatalog.models || []).filter((model) =>
    model.status !== 'review' && (scopeProduct === 'both' || model.product === scopeProduct)
  );
  const currentModels = availableModels.filter((model) => model.status === 'current');
  const previousModels = availableModels.filter((model) => model.status === 'previous');
  const selectedModelName = availableModels.find((model) => model.slug === scopeModel)?.name ||
    (scopeProduct === 'both' ? 'All products' : `All ${scopeProduct.toUpperCase()} models`);
  const productGroups = [{ label: 'Knowledge family', options: [
    { value: 'cfd', label: 'CFD', description: 'CFD Accounts and policies' },
    { value: 'futures', label: 'Futures', description: 'Futures models and policies' },
    { value: 'both', label: 'Both', description: 'Search both product families' }
  ] }];
  const modelGroups = [
    { label: 'Scope', options: [{ value: 'all', label: scopeProduct === 'both' ? 'All products and models' : `All ${scopeProduct.toUpperCase()} models`, description: 'Use every verified model in this family' }] },
    ...(currentModels.length ? [{ label: 'Current models', options: currentModels.map((model) => ({ value: model.slug, label: model.name, description: `${model.articleCount || 0} matching FAQ article${model.articleCount === 1 ? '' : 's'}`, badge: 'Current', badgeTone: 'current' })) }] : []),
    ...(previousModels.length ? [{ label: 'Previous models', options: previousModels.map((model) => ({ value: model.slug, label: model.name, description: `${model.articleCount || 0} saved FAQ article${model.articleCount === 1 ? '' : 's'}`, badge: 'Not currently live', badgeTone: 'previous' })) }] : [])
  ];
  const scopeIsDefault = savedScope.product === scopeProduct && savedScope.model === scopeModel;

  return (
    <main className="app-shell">
      <header className="app-header"><Brand /><div className="header-actions">{identity.name && <div className="user-identity"><b>{identity.name}</b><small>{identity.email}</small></div>}{!identity.name && <span className="role-badge">{role}</span>}<button className="header-action" onClick={toggleTheme} aria-label="Change theme"><span>{theme === 'dark' ? '☀' : '☾'}</span><b>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</b></button>{role === 'admin' && <Link className="btn btn-secondary btn-small" href="/admin">Admin console</Link>}<button className="header-action" onClick={logout} aria-label="Sign out"><span>⏻</span><b>Sign out</b></button></div></header>

      {role === 'admin' && <div className={`sync-console ${syncOpen ? 'expanded' : ''}`}><div className="sync-summary"><div className="sync-headline"><span className={`sync-activity ${syncing ? 'working' : ''}`} aria-hidden="true"><i /><i /><i /></span><div><b>{syncState.headline}</b><small>{syncing ? `Syncing · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} elapsed` : 'Knowledge base ready'}</small></div></div><div className="row"><button className="text-button neutral" onClick={() => setSyncOpen(!syncOpen)}>{syncOpen ? 'Hide details' : 'View details'}</button><button className="btn btn-secondary btn-small" onClick={checkUpdates} disabled={syncing}>{syncing ? 'Syncing…' : 'Check for updates'}</button>{syncing && <button className="text-button" onClick={() => { cancelRef.current = true; abortRef.current?.abort(); }}>Cancel</button>}</div></div>{syncOpen && <div className="sync-details">{syncState.details.map((detail, index) => <div key={index} className={`sync-step ${syncing ? 'pending' : ''}`}><span className="tick">{syncing ? index + 1 : '✓'}</span><span className="detail">{detail}</span></div>)}</div>}</div>}

      <div className="workspace-grid">
        <section className="assistant-card">
          <div className="chat-thread" ref={threadRef}>
            {!messages.length && <div className="welcome-state"><div className="assistant-orb"><Logo /></div><span className="status-chip">Source-backed assistance</span><h1>How can I help today?</h1><p>Ask about a policy, Account, Performance Reward, trading rule, or platform.</p><div className="suggestion-grid">{['How does trailing drawdown work?', 'Explain Performance Reward eligibility', 'What causes an Account breach?'].map((question) => <button key={question} onClick={() => send(question)}>{question}<span>↗</span></button>)}</div></div>}
            {messages.map((message, index) => message.role === 'user'
              ? <div className="message user-message" key={index}><div className="message-label">You</div><div className="user-bubble">{message.content}</div></div>
              : <div className="message assistant-message" key={index}><div className="bot-avatar"><Logo /></div><div className={`assistant-bubble${message.error ? ' error-bubble' : ''}`}><div className="answer-head"><span>FundedNext Assistant</span><div>{Number.isFinite(message.confidence) && <ConfidenceHealth score={message.confidence} label={message.confidenceLabel} reasons={message.confidenceReasons} />}<small>{message.fallback ? 'OpenAI backup' : message.provider === 'groq' ? 'Groq' : 'OpenAI'}</small>{message.fallback && <span className="fallback-flash" title="Groq was busy, so this answer switched to GPT">⚡ Switched to GPT</span>}{message.usedCalculator && <span className="calc-tag" title="This answer used trade-calculator logic">⚙ Calculator logic</span>}</div></div>{message.segments?.length ? <AttributedAnswer segments={message.segments} sources={message.sources} /> : <Answer text={message.content} />}<div className="answer-actions"><button onClick={() => copyAnswer(index, message.content)}>{copied === index ? '✓ Copied' : '⧉ Copy answer'}</button><button className={message.disputed ? 'disputed' : ''} disabled={message.disputed || message.error} onClick={() => { setDisputeIndex(index); setDisputeReason(''); setDisputeError(''); }}>{message.disputed ? '✓ Answer disputed' : '⚑ Dispute answer'}</button></div>{message.sources?.length > 0 && <div className="sources"><button className="sources-toggle" onClick={() => setOpenSources((current) => ({ ...current, [index]: !current[index] }))}><span>◆</span>{message.sources.length} verified source{message.sources.length > 1 ? 's' : ''}<b>{openSources[index] ? '−' : '+'}</b></button>{openSources[index] && <div className="sources-list">{message.sources.map((source, sourceIndex) => <a key={sourceIndex} href={source.url || undefined} target="_blank" rel="noreferrer" className={source.kind === 'calculator' ? 'src-calc' : ''}><span className="src-num">{sourceIndex + 1}</span><span className="src-title">{source.title}</span><small>{source.kind === 'calculator' ? '⚙ Calculator' : 'Open article ↗'}</small></a>)}</div>}</div>}</div></div>
            )}
            {loading && <div className="message assistant-message"><div className="bot-avatar thinking-avatar"><Logo /></div><div className="assistant-bubble thinking-card"><div className="thinking-head"><span className="knowledge-scan" aria-hidden="true"><i /><i /><i /><b /></span><div><b>Building a verified answer</b><small>Locked to {scopeProduct.toUpperCase()} · {selectedModelName}</small></div><span className="thinking-count">{thinkingStep + 1}/{THINKING_STEPS.length}</span></div><div className="thinking-label"><span key={thinkingStep}>{THINKING_STEPS[thinkingStep]}</span></div><div className="thinking-skeleton"><i /><i /><i /></div><div className="thinking-progress">{THINKING_STEPS.map((step, i) => <i key={step} className={i < thinkingStep ? 'active' : i === thinkingStep ? 'active current' : ''} />)}</div></div></div>}
          </div>
          <div className="composer-wrap">
            <div className="scope-bar" aria-label="Knowledge scope"><div className="scope-heading"><span>Answer scope</span><small>The assistant cannot search outside this selection</small><button type="button" className={`scope-default${scopeIsDefault ? ' saved' : ''}`} disabled={scopeIsDefault} onClick={saveDefaultScope}>{scopeIsDefault ? '✓ My default' : '☆ Set as my default'}</button></div><ScopeSelect label="Product" value={scopeProduct} groups={productGroups} onChange={(next) => saveScope(next, 'all')} /><ScopeSelect label="Account model" value={scopeModel} groups={modelGroups} onChange={(next) => saveScope(scopeProduct, next)} className="scope-model" /></div>
            {scopeNotice && <div className="scope-notice" role="status"><div><b>{scopeNotice.title}</b><span>{scopeNotice.text}</span></div>{scopeModel !== 'all' && <button onClick={() => saveScope(scopeProduct, 'all')}>Search all {scopeProduct.toUpperCase()} models</button>}</div>}
            <div className="composer"><textarea value={input} placeholder={`Ask about ${selectedModelName}…`} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} /><button onClick={() => send()} disabled={!input.trim() || loading} aria-label="Send">↑</button></div><div className="composer-foot"><div className="composer-note">Review the confidence and verified source before sending the answer.</div><div className="developer-credit"><i />Developed by <span>Faiyaz Ahmed</span></div></div></div>
        </section>

        <aside className="insights-rail"><div className="rail-head"><span className="live-dot" /><div><b>Knowledge health</b><small>{stats?.healthy ? 'All systems operational' : 'Checking status…'}</small></div></div><div className="metric-card model-card"><span>Answering model</span><strong>{stats?.answerProvider === 'groq' ? 'Groq' : 'OpenAI'}</strong><small>{stats?.answerModel || 'Checking model…'}</small><em>{role === 'admin' ? 'Automatic GPT fallback: on (admin only)' : 'Automatic fallback is off'}</em></div><div className="metric-card primary"><span>Published articles</span><strong>{stats?.totalArticles?.toLocaleString() ?? '—'}</strong><small>Total articles stored and available</small></div><div className="metric-grid"><div className="metric-card"><span>Indexed</span><strong>{stats?.indexedArticles?.toLocaleString() ?? '—'}</strong></div><div className="metric-card"><span>Queued</span><strong>{stats?.queuedArticles?.toLocaleString() ?? '—'}</strong></div></div><div className="metric-card"><span>Searchable sections</span><strong>{stats?.totalChunks?.toLocaleString() ?? '—'}</strong><small>Focused pieces used for retrieval</small></div><div className="metric-card update-time"><span>Last knowledge update</span><strong>{formatDhaka(stats?.lastUpdatedAt)}</strong>{stats?.lastSyncAt && <small className="sync-ago"><span className="live-dot tiny" />Auto-synced {timeAgo(stats.lastSyncAt)}{stats?.lastSyncSummary?.changed ? ` · ${stats.lastSyncSummary.changed} updated` : ' · no changes'}</small>}</div>{role === 'admin' && <div className="metric-card dispute-metric"><span>Pending disputes</span><strong>{stats?.pendingDisputes ?? '—'}</strong><Link href="/admin">Review in Admin →</Link></div>}<div className="rail-tip"><b>Confidence guide</b><p><span className="dot high" />85–100: strong direct support</p><p><span className="dot medium" />65–84: review suggested</p><p><span className="dot low" />Below 65: verify carefully</p></div></aside>
      </div>

      {disputeIndex !== null && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setDisputeIndex(null)}><div className="modal-card"><div className="modal-icon">⚑</div><h2>Dispute this answer?</h2><p>Explain exactly what appears incorrect or incomplete. Your reason is required and will be reviewed by an Admin.</p><label htmlFor="dispute-reason">Reason for dispute</label><textarea id="dispute-reason" value={disputeReason} onChange={(event) => setDisputeReason(event.target.value)} placeholder="Example: The Performance Reward cycle is outdated for the Stellar Instant Account…" autoFocus />{disputeError && <div className="inline-error">{disputeError}</div>}<div className="modal-actions"><button className="btn btn-secondary" onClick={() => setDisputeIndex(null)}>Cancel</button><button className="btn btn-danger" onClick={submitDispute} disabled={submittingDispute}>{submittingDispute ? 'Submitting…' : 'Submit dispute'}</button></div></div></div>}
      {clarification && <div className="clarify-backdrop" role="presentation"><section className="clarify-dialog" role="dialog" aria-modal="true" aria-labelledby="clarify-title"><div className="clarify-icon">?</div><span className="eyebrow">One detail needed</span><h2 id="clarify-title">{clarification.question}</h2><p>{clarification.reason || 'This detail determines which FAQ rule applies. Select the option that matches the customer’s situation.'}</p><div className="clarify-choices">{clarification.choices.map((choice) => <button key={choice.value || choice} onClick={() => answerClarification(choice)}><span className="clarify-choice-copy"><b>{choice.label || choice}</b>{choice.description && <small>{choice.description}</small>}</span><span className="clarify-arrow">→</span></button>)}</div><div className="clarify-other"><label htmlFor="clarify-other">None of these? Add the exact missing detail</label><div><input id="clarify-other" value={clarificationOther} onChange={(e) => setClarificationOther(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && answerClarification(clarificationOther)} placeholder="Type the customer’s Account model or intent…" autoFocus /><button className="btn btn-primary" disabled={!clarificationOther.trim()} onClick={() => answerClarification(clarificationOther)}>Use this detail</button></div></div><button className="clarify-cancel" onClick={() => { setClarification(null); setClarificationOther(''); }}>Cancel</button></section></div>}
    </main>
  );
}
