import { useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';

function Logo() {
  return <svg className="audit-logo" viewBox="12 15 41 32" aria-hidden="true"><path d="M15 19h13v5.4h-7.4v4.1H27v5.3h-6.4V45H15zM31 19h5.1l9 12.4V19h5.6v26h-5.1l-9-12.3V45H31z"/><path className="accent" d="M41.4 19H50.7v9.3z"/></svg>;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(value)) + ' GMT+6';
}

function auditAgentLabel(job, results = []) {
  const names = [...new Set([...(job?.agentNames || []), ...results.map((item) => item.agentName)].map((item) => String(item || '').trim()).filter(Boolean))];
  if (!names.length) return job?.mode === 'direct' ? 'Direct audit' : 'Agent audit';
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}

function auditDownloadBase(job, results = []) {
  const agent = auditAgentLabel(job, results).normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'agent';
  return `${agent}-audit-${job?.id}`;
}

function today(offset = 0) {
  const date = new Date(Date.now() + offset * 86400000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function pad(value) { return String(value).padStart(2, '0'); }
function isoOf(year, month, day) { return `${year}-${pad(month + 1)}-${pad(day)}`; }
function shiftIso(iso, days) { const [year, month, day] = iso.split('-').map(Number); const date = new Date(Date.UTC(year, month - 1, day + days)); return isoOf(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()); }
function formatShortDate(iso, year = true) { const [y, m, d] = iso.split('-').map(Number); return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) }).format(new Date(Date.UTC(y, m - 1, d))); }
function rangeLabel(from, to) { if (!from && !to) return 'All time'; if (from === to) return formatShortDate(from); return `${from.slice(0, 4) === to.slice(0, 4) ? formatShortDate(from, false) : formatShortDate(from)} – ${formatShortDate(to)}`; }
function monthName(year, month) { return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(Date.UTC(year, month, 1))); }

function AuditMonthGrid({ year, month, from, to, hoverIso, onPick, onHover, maxIso }) {
  const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay(); const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); const cells = [];
  for (let index = 0; index < firstDay; index++) cells.push(null); for (let day = 1; day <= count; day++) cells.push(day);
  const end = to || (from && hoverIso && hoverIso > from ? hoverIso : '');
  return <div className="cal-grid">{['Su','Mo','Tu','We','Th','Fr','Sa'].map((day) => <div key={day} className="cal-dow">{day}</div>)}{cells.map((day, index) => {
    if (!day) return <div key={index}/>; const iso = isoOf(year, month, day); const disabled = maxIso && iso > maxIso; const start = iso === from; const finish = iso === end; const inRange = from && end && iso > from && iso < end;
    const classes = ['cal-day']; if (inRange) classes.push('in-range'); if (start || finish) classes.push('edge', start && finish ? 'single' : start ? 'start' : 'end');
    return <button key={index} type="button" disabled={disabled} className={classes.join(' ')} onMouseEnter={() => onHover(iso)} onClick={() => onPick(iso)}>{day}</button>;
  })}</div>;
}

function AuditDateRangeFilter({ from, to, onApply }) {
  const [open, setOpen] = useState(false); const [custom, setCustom] = useState(false); const [draftFrom, setDraftFrom] = useState(from); const [draftTo, setDraftTo] = useState(to); const [hover, setHover] = useState(''); const ref = useRef(null); const maximum = today();
  const base = to || from || maximum; const [viewYear, setViewYear] = useState(Number(base.slice(0, 4))); const [viewMonth, setViewMonth] = useState(Number(base.slice(5, 7)) - 1);
  useEffect(() => { function close(event) { if (ref.current && !ref.current.contains(event.target)) { setOpen(false); setCustom(false); } } if (open) document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close); }, [open]);
  const presets = [['Today',[maximum,maximum]],['Yesterday',[shiftIso(maximum,-1),shiftIso(maximum,-1)]],['Past 7 days',[shiftIso(maximum,-6),maximum]],['Past 30 days',[shiftIso(maximum,-29),maximum]],['This month',[`${maximum.slice(0,7)}-01`,maximum]],['Past 3 months',[shiftIso(maximum,-90),maximum]]];
  const active = presets.find(([, range]) => range[0] === from && range[1] === to)?.[0] || 'Custom';
  function showCustom() { setDraftFrom(from); setDraftTo(to); setHover(''); const value = to || from || maximum; setViewYear(Number(value.slice(0,4))); setViewMonth(Number(value.slice(5,7))-1); setCustom(true); }
  function pick(iso) { if (!draftFrom || (draftFrom && draftTo)) { setDraftFrom(iso); setDraftTo(''); } else if (iso < draftFrom) { setDraftFrom(iso); setDraftTo(''); } else setDraftTo(iso); }
  function step(delta) { const date = new Date(Date.UTC(viewYear, viewMonth + delta, 1)); setViewYear(date.getUTCFullYear()); setViewMonth(date.getUTCMonth()); }
  const right = new Date(Date.UTC(viewYear, viewMonth + 1, 1));
  return <div className="date-filter audit-date-filter" ref={ref}><button type="button" className={`date-trigger ${open ? 'open' : ''}`} onClick={() => { setOpen((value) => !value); setCustom(false); }}><span className="cal-ico">▦</span><span><small>Date range</small><b>{rangeLabel(from,to)}</b></span><span className="caret">▾</span></button>{open && <div className="date-pop"><div className="date-presets">{presets.map(([label, range]) => <button type="button" key={label} className={`date-preset ${active === label ? 'active' : ''}`} onMouseEnter={() => setCustom(false)} onClick={() => { onApply(...range); setOpen(false); }}>{label}{active === label && <span className="ck">✓</span>}</button>)}<button type="button" className={`date-preset custom ${active === 'Custom' ? 'active' : ''}`} onMouseEnter={showCustom} onClick={showCustom}>Custom range<span className="ck">›</span></button></div>{custom && <div className="date-cal"><div className="range-head"><div><label>From</label><b className={draftFrom ? '' : 'empty'}>{draftFrom ? formatShortDate(draftFrom) : 'Select date'}</b></div><div><label>To</label><b className={draftTo ? '' : 'empty'}>{draftTo ? formatShortDate(draftTo) : 'Select date'}</b></div></div><div className="cal-wrap"><div><div className="cal-nav"><button type="button" onClick={() => step(-1)}>‹</button><b>{monthName(viewYear,viewMonth)}</b><span/></div><AuditMonthGrid year={viewYear} month={viewMonth} from={draftFrom} to={draftTo} hoverIso={hover} onPick={pick} onHover={setHover} maxIso={maximum}/></div><div><div className="cal-nav"><span/><b>{monthName(right.getUTCFullYear(),right.getUTCMonth())}</b><button type="button" onClick={() => step(1)}>›</button></div><AuditMonthGrid year={right.getUTCFullYear()} month={right.getUTCMonth()} from={draftFrom} to={draftTo} hoverIso={hover} onPick={pick} onHover={setHover} maxIso={maximum}/></div></div><div className="date-foot"><button type="button" className="btn btn-secondary btn-small" onClick={() => setCustom(false)}>Cancel</button><button type="button" className="btn btn-primary btn-small" disabled={!draftFrom} onClick={() => { onApply(draftFrom, draftTo || draftFrom); setOpen(false); setCustom(false); }}>Apply range</button></div></div>}</div>}</div>;
}

function StatusOrb({ state = 'checking' }) {
  return <span className={`audit-status-orb ${state}`} aria-hidden="true"><i/><i/><b>{state === 'healthy' ? '✓' : state === 'offline' ? '!' : '•'}</b></span>;
}

function AuditLaunchLoader() {
  return <main className="audit-loading audit-launch-loader" role="status" aria-live="polite">
    <div className="audit-loader-scene" aria-hidden="true">
      <span className="audit-loader-core"><Logo /></span><i className="loader-orbit orbit-one"><b>✓</b></i><i className="loader-orbit orbit-two"><b>AI</b></i><i className="loader-orbit orbit-three"><b>↻</b></i><span className="audit-loader-scan" />
    </div>
    <span className="audit-loader-eyebrow">Secure workspace startup</span><h2>Preparing Conversation Audit</h2><p>Connecting access, Intercom agents and saved audit history…</p>
    <div className="audit-loader-steps"><span className="active"><i />Verify access</span><span><i />Connect services</span><span><i />Restore history</span></div>
  </main>;
}

function AuditBatchPreparation({ elapsed = 0, direct = false, requested = 0 }) {
  const steps = direct ? [
    ['Validating conversation IDs', 'Checking that each Intercom conversation can be opened.'],
    ['Creating the saved batch', 'The audit will appear in history as soon as preparation finishes.']
  ] : [
    ['Finding eligible conversations', 'Bot-only chats and conversations without a meaningful agent reply are excluded.'],
    ['Comparing recent candidates', 'The strongest samples are selected by the chosen agent’s own message count.'],
    ['Creating the saved batch', 'Progress will be saved after every conversation.']
  ];
  const active = Math.min(steps.length - 1, Math.floor(elapsed / 8));
  return <section className="audit-batch-preparation" role="status" aria-live="polite">
    <div className="audit-loader-scene compact" aria-hidden="true"><span className="audit-loader-core"><Logo /></span><i className="loader-orbit orbit-one"><b>✓</b></i><i className="loader-orbit orbit-two"><b>QA</b></i><span className="audit-loader-scan" /></div>
    <span className="audit-loader-eyebrow">Building a reliable sample</span>
    <h2>{steps[active][0]}</h2><p>{steps[active][1]}</p>
    <div className="batch-preparation-meta"><b>{elapsed}s</b><span>{direct ? `${requested} requested conversation${requested === 1 ? '' : 's'}` : `${requested} priority conversation${requested === 1 ? '' : 's'}`}</span></div>
    <div className="audit-loader-steps">{steps.map(([label], index) => <span key={label} className={index === active ? 'active' : index < active ? 'complete' : ''}><i />{label}</span>)}</div>
    <small>This preparation can take longer for wide date ranges because Intercom candidates are checked before the batch is saved.</small>
  </section>;
}

function ConnectionLogo({ type, state }) {
  const common = { viewBox: '0 0 32 32', 'aria-hidden': true };
  return <span className={`connection-logo ${type} ${state}`}>{type === 'intercom' ? <svg {...common}><rect x="5" y="4" width="22" height="24" rx="6"/><path d="M10 10v8m4-8v9m4-9v9m4-9v8M9 22c4.5 3 9.5 3 14 0"/></svg> : type === 'gemini' ? <svg {...common}><path d="M16 3c1.6 7.4 5.6 11.4 13 13-7.4 1.6-11.4 5.6-13 13-1.6-7.4-5.6-11.4-13-13C10.4 14.4 14.4 10.4 16 3Z"/></svg> : <svg {...common}><path d="M5 7.5c5-1.2 8.6-.4 11 2.3 2.4-2.7 6-3.5 11-2.3v19c-4.8-1-8.5-.2-11 2.3-2.5-2.5-6.2-3.3-11-2.3Z"/><path d="M16 10v18"/></svg>}<i/></span>;
}

function Metric({ label, value, detail, tone = '' }) {
  const icon = /quality/i.test(label) ? 'Q' : /efficiency/i.test(label) ? 'E' : /final/i.test(label) ? '★' : /review/i.test(label) ? '!' : /chat/i.test(label) ? '✓' : '#';
  const numeric = Number(value); const scoreTone = /average/i.test(label) && Number.isFinite(numeric) ? (numeric >= 8 ? 'score-good' : numeric >= 6 ? 'score-watch' : 'score-risk') : '';
  return <div className={`audit-metric ${tone} ${scoreTone}`}><i aria-hidden="true">{icon}</i><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

function ThresholdGroup({ title, value, onChange, note }) {
  const update = (key, raw, multiplier = 1) => onChange({ ...value, [key]: Math.max(1, Math.round(Number(raw || 0) * multiplier)) });
  return <fieldset className="threshold-editor"><legend>{title}</legend><p>{note}</p><div><label>FRT target<small>seconds</small><input type="number" min="1" max="600" value={value.frtSeconds} onChange={(event) => update('frtSeconds', event.target.value)}/></label><label>ART target<small>seconds</small><input type="number" min="1" max="1800" value={value.artSeconds} onChange={(event) => update('artSeconds', event.target.value)}/></label><label>AHT target<small>minutes</small><input type="number" min="1" max="240" step="1" value={Math.round(value.ahtSeconds / 60)} onChange={(event) => update('ahtSeconds', event.target.value, 60)}/></label></div></fieldset>;
}

function AuditSnippetEditor({ snippet, busy, onSave, onDelete }) {
  const [draft, setDraft] = useState({ title: snippet.title || '', triggerTerms: snippet.triggerTerms || '', instruction: snippet.instruction || '', active: snippet.active !== false });
  useEffect(() => setDraft({ title: snippet.title || '', triggerTerms: snippet.triggerTerms || '', instruction: snippet.instruction || '', active: snippet.active !== false }), [snippet.id, snippet.updatedAt]);
  return <article className={`audit-snippet-card ${draft.active ? '' : 'inactive'}`}><header><div><span>{draft.active ? 'Active audit guidance' : 'Inactive audit guidance'}</span><h3>{draft.title || `Audit snippet #${snippet.id}`}</h3></div><label><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })}/> Active</label></header><label>Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })}/></label><label>Trigger terms<input value={draft.triggerTerms} onChange={(event) => setDraft({ ...draft, triggerTerms: event.target.value })}/></label><label>Audit instruction<textarea rows={5} value={draft.instruction} onChange={(event) => setDraft({ ...draft, instruction: event.target.value })}/></label><div className="audit-snippet-meta"><span>Approved {formatDate(snippet.approvedAt || snippet.createdAt)}</span><span>{snippet.evidence?.length || 0} FAQ/Notice references</span><span>Source result #{snippet.resultId}</span></div>{snippet.evidence?.length > 0 && <details className="audit-snippet-evidence"><summary>Supporting FAQ and Notice references</summary>{snippet.evidence.map((item, index) => <div key={`${item.url || item.title || 'evidence'}-${index}`}><b>{item.kind || 'Knowledge'}</b>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.title || item.url} ↗</a> : <span>{item.title || 'Stored evidence reference'}</span>}</div>)}</details>}<footer><button className="danger" disabled={busy} onClick={() => onDelete(snippet)}>Delete</button><button className="primary" disabled={busy || draft.instruction.trim().length < 20} onClick={() => onSave(snippet, draft)}>Save changes</button></footer></article>;
}

function AuditTip({ text, label = 'More information' }) {
  return <span className="audit-tip" tabIndex="0" aria-label={`${label}: ${text}`}><b aria-hidden="true">i</b><span role="tooltip">{text}</span></span>;
}

function ScoreRing({ value }) {
  const score = Math.max(0, Math.min(10, Number(value) || 0));
  return <div className="score-ring" style={{ '--score': `${score * 10}%` }}><span><b>{score.toFixed(2).replace(/\.00$/, '')}</b><small>/10</small></span></div>;
}

function conversationHref(result) {
  const saved = String(result?.intercomLink || '');
  if (/^https:\/\/app\.intercom\.com\/a\/inbox\//i.test(saved)) return saved;
  return `https://app.intercom.com/a/inbox/_/inbox/search?query=${encodeURIComponent(result?.conversationId || '')}`;
}

function CopyConversationId({ value }) {
  const [copied, setCopied] = useState(false);
  async function copy(event) {
    event.preventDefault(); event.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(value || ''));
      setCopied(true); window.setTimeout(() => setCopied(false), 1400);
    } catch { /* The linked ID remains selectable if clipboard access is blocked. */ }
  }
  return <button type="button" className={`copy-conversation ${copied ? 'copied' : ''}`} onClick={copy} title="Copy conversation ID" aria-label={`Copy conversation ${value}`}>{copied ? 'Copied' : 'Copy'}</button>;
}

function AhtVerification({ result }) {
  const metrics = result?.metrics || {}; const cycles = metrics.ahtCycles || []; const unavailable = metrics.timingUnavailableReasons || [];
  if (!cycles.length && !unavailable.length && !metrics.assignmentEvidence) return null;
  const stamp = (seconds) => seconds ? formatDate(new Date(Number(seconds) * 1000).toISOString()) : 'Unavailable';
  return <section className="aht-verification"><header><div><span>Timing verification ledger</span><h4>Exact provenance and anchors</h4></div><b>{cycles.length} episode{cycles.length === 1 ? '' : 's'}</b></header>{metrics.assignmentEvidence && <div className="timing-provenance"><b>{metrics.assignmentEvidence.inferred ? 'Recovered assignment anchor' : 'Explicit assignment anchor'}</b><span>{stamp(metrics.assignmentEvidence.at)} · event {metrics.assignmentEvidence.eventId || 'Intercom event without ID'}</span><small>{metrics.assignmentEvidence.actorId ? `Initiator ${metrics.assignmentEvidence.actorId}` : 'No initiator ID supplied — never treated as self-assignment'}</small></div>}{unavailable.length > 0 && <div className="timing-unavailable"><b>Unavailable measurements</b>{unavailable.map((reason) => <span key={reason}>{reason}</span>)}</div>}{cycles.map((cycle, index) => <article key={cycle.replyId || index}><div className="aht-episode-title"><b>Episode {index + 1} · {Math.floor(Number(cycle.seconds || 0) / 60)}m {Math.round(Number(cycle.seconds || 0)) % 60}s</b><small>{cycle.basis === 'resumed_after_previous_handling_action' ? 'Resumed after preceding handled action' : cycle.basis === 'client_return' ? 'Client returned' : 'Assignment/episode became actionable'}</small></div><dl><div><dt>Ready</dt><dd>{stamp(cycle.readyAt || cycle.startAt)}</dd></div><div><dt>Counted from</dt><dd>{stamp(cycle.startAt)}</dd></div><div><dt>Reply sent</dt><dd>{stamp(cycle.replyAt)}</dd></div><div><dt>{cycle.endType || 'Handling end'}</dt><dd>{stamp(cycle.endAt)}</dd></div></dl><div className="aht-previous">{cycle.previousConversationId ? <><span>Previous client-visible reply</span><a href={cycle.previousConversationLink || `https://app.intercom.com/a/inbox/_/inbox/search?query=${encodeURIComponent(cycle.previousConversationId)}`} target="_blank" rel="noreferrer">Conversation {cycle.previousConversationId} ↗</a><CopyConversationId value={cycle.previousConversationId}/><time>{stamp(cycle.previousReplyAt)}</time></> : <span>No earlier completed client-visible reply was available; this episode starts from its own ready time.</span>}</div></article>)}</section>;
}

function TranscriptBody({ text, flags = [], highlight = false }) {
  const body = String(text || ''); const oversized = body.length > 1400 || (body.match(/https?:\/\/|%2F/gi) || []).length > 4;
  const rendered = <HighlightedMessage text={body} flags={highlight ? flags : []}/>;
  if (!oversized) return rendered;
  return <details className="long-transcript-body"><summary>Long email content · Show full message</summary><div>{rendered}</div></details>;
}

function calculatedFinal(audit) { return Number(((Number(audit?.quality || 0) + Number(audit?.efficiency || 0) + Number(audit?.complexity || 0)) / 3).toFixed(2)); }
function displayDeductions(audit) {
  const scores = { quality: Number(audit?.quality || 0), efficiency: Number(audit?.efficiency || 0), process: Number(audit?.complexity || 0) };
  const comments = { quality: audit?.qualityComment, efficiency: audit?.efficiencyComment, process: audit?.complexityComment };
  const supplied = Array.isArray(audit?.deductions) ? audit.deductions : []; const output = [];
  for (const [category, score] of Object.entries(scores)) {
    const expected = Math.max(0, 10 - score); if (!expected) continue;
    const items = supplied.filter((item) => {
      const stored = String(item.category || '').toLowerCase();
      return category === 'process' ? (stored.includes('process') || stored.includes('complex')) : stored.includes(category);
    });
    const usable = items.length ? items : [{ category, reason: comments[category] || 'The score was reduced in this category.', transcriptExample: '', betterAction: '', pointsDeducted: expected }];
    const totalWeight = usable.reduce((sum, item) => sum + Math.max(.1, Number(item.pointsDeducted) || 1), 0); let allocated = 0;
    usable.forEach((item, index) => { const points = index === usable.length - 1 ? Number((expected - allocated).toFixed(2)) : Number((expected * Math.max(.1, Number(item.pointsDeducted) || 1) / totalWeight).toFixed(2)); allocated += points; output.push({ ...item, category, pointsDeducted: points }); });
  }
  return output;
}

function cleanFlagPhrase(value) {
  const text = String(value || '').trim(); const quoted = [...text.matchAll(/["“”']([^"“”']{6,})["“”']/g)].map((match) => match[1]).sort((a, b) => b.length - a.length)[0];
  return String(quoted || text.replace(/^(?:example\s*:\s*)?(?:the\s+)?agent\s*:\s*/i, '')).trim().replace(/^["“”']|["“”']$/g, '');
}
function flagSpecs(audit) {
  const deductionFlags = displayDeductions(audit).filter((item) => item.transcriptExample).map((item) => ({ phrase: cleanFlagPhrase(item.transcriptExample), category: item.category, label: `${item.category} deduction` }));
  const accuracyFlags = (audit?.accuracyIssues || []).filter((item) => item.wrongInformation).map((item) => ({ phrase: cleanFlagPhrase(item.wrongInformation), category: 'accuracy', label: 'Incorrect information' }));
  return [...deductionFlags, ...accuracyFlags].filter((item) => item.phrase.length >= 5);
}
function flagSpan(text, phrase) {
  const source = String(text || ''); const target = String(phrase || '');
  const exact = source.toLowerCase().indexOf(target.toLowerCase());
  if (exact >= 0) return { start: exact, end: exact + target.length };
  const terms = target.toLowerCase().match(/[a-z0-9]{4,}/g) || [];
  if (terms.length < 2) return null;
  let cursor = 0; let best = null;
  for (const segment of source.split(/(?<=[.!?])\s+|\n+/)) {
    const start = source.indexOf(segment, cursor); cursor = Math.max(cursor, start + segment.length);
    const lower = segment.toLowerCase(); const ratio = terms.filter((word) => lower.includes(word)).length / terms.length;
    if (ratio >= .7 && (!best || ratio > best.ratio)) best = { start, end: start + segment.length, ratio };
  }
  return best;
}
function matchedFlags(text, flags) {
  return flags.filter((flag) => !!flagSpan(text, flag.phrase));
}
function HighlightedMessage({ text, flags }) {
  const matches = matchedFlags(text, flags); if (!matches.length) return <>{text}</>;
  let parts = [{ text: String(text || ''), marked: false, category: '' }];
  for (const flag of matches) parts = parts.flatMap((part) => { if (part.marked) return [part]; const span = flagSpan(part.text, flag.phrase); if (!span) return [part]; return [{ text: part.text.slice(0,span.start), marked:false },{ text: part.text.slice(span.start,span.end), marked:true, category:flag.category },{ text:part.text.slice(span.end), marked:false }].filter((item) => item.text); });
  return <>{parts.map((part, index) => part.marked ? <mark key={index} className={`flag-${part.category}`}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</>;
}
function formatSeconds(value) { const seconds = Math.max(0, Number(value) || 0); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
function timelineSeconds(value) { if (typeof value === 'number' && Number.isFinite(value)) return value; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed / 1000 : 0; }
function timelineKind(turn) {
  const body = String(turn?.body || '').trim();
  const role = turn?.kind || turn?.role || 'bot';
  const machineMarker = /^\[[a-z0-9_ -]+\]$/i.test(body);
  if (role === 'agent' && /note|internal/i.test(String(turn?.partType || ''))) return 'internal-note';
  // Intercom can attach event-like part types to delivered email replies. A
  // genuine human-authored body must retain its client/agent presentation.
  if (body && !machineMarker && (role === 'client' || role === 'agent')) return role;
  if (machineMarker || /assign|attribute|close|snooze|open|sla/i.test(turn?.partType || '')) return 'event';
  return role;
}
function turnDomId(id) { return `audit-turn-${String(id || 'transcript').replace(/[^a-zA-Z0-9_-]/g, '-')}`; }
function deductionEvidenceTarget(item, index, timeline, metrics) {
  const excerpt = cleanFlagPhrase(item?.transcriptExample || '');
  if (excerpt) {
    const matched = timeline.find((turn) => turn.timelineKind === 'agent' && flagSpan(turn.body, excerpt));
    if (matched) return matched.id;
  }
  const reason = String(item?.reason || '').toLowerCase();
  if (/self.?assign/.test(reason)) return 'metric-self-assignment';
  if (/\bfrt\b|first response/.test(reason)) return 'metric-frt';
  if (/\bart\b|agent response/.test(reason)) return (metrics.responseCycles || []).find((cycle) => cycle.breached)?.replyId ? `metric-art-${(metrics.responseCycles || []).find((cycle) => cycle.breached).replyId}` : 'metric-art';
  if (/\baht\b|handling time/.test(reason)) return 'metric-aht';
  if (/investigation|chat holding|holding status/.test(reason)) return metrics.investigationOnDelays?.[0]?.requestId || metrics.investigationOffDelays?.[0]?.replyId || 'transcript';
  return timeline.find((turn) => turn.timelineKind === 'agent')?.id || 'transcript';
}
function jumpToEvidence(id) {
  const target = document.getElementById(turnDomId(id));
  if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.add('evidence-focus'); window.setTimeout(() => target.classList.remove('evidence-focus'), 1800); }
}
function readableEvent(value) {
  const marker = String(value || '').replace(/^\[|\]$/g, '').replace(/_/g, ' ').trim();
  return marker ? marker.replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Intercom event';
}
function comparisonTimeline(turns, result) {
  const items = turns.map((turn) => ({ ...turn, at: timelineSeconds(turn.at || turn.createdAt), authorName: turn.authorName || turn.author || 'Unknown', timelineKind: timelineKind(turn) }));
  const metrics = result?.metrics || {}; const metricEvents = [];
  if (metrics.assignmentInferred && metrics.assignmentAt) metricEvents.push({ id: 'metric-inferred-assignment', at: timelineSeconds(metrics.assignmentAt) + .02, timelineKind: 'metric', metricTone: 'hit', authorName: 'L2 timing anchor', body: 'AHT anchor recovered from the nearest Intercom assignment event because its assignee ID was missing' });
  if (metrics.selfAssigned && (metrics.selfAssignmentAt || metrics.assignmentAt)) metricEvents.push({ id: 'metric-self-assignment', at: timelineSeconds(metrics.selfAssignmentAt || metrics.assignmentAt) + .05, timelineKind: 'metric', metricTone: 'miss', authorName: 'Self-assignment violation', body: 'Agent assigned this conversation to themselves · Efficiency automatically set to 0/10' });
  if (metrics.firstResponseAt && metrics.frtSeconds != null) metricEvents.push({ id: 'metric-frt', at: timelineSeconds(metrics.firstResponseAt) - .2, timelineKind: 'metric', metricTone: metrics.frtHit === false ? 'miss' : 'hit', authorName: 'FRT', body: `${formatSeconds(metrics.frtSeconds)} · ${metrics.frtHit === false ? 'Missed' : 'Met'} 30s target` });
  const responseCycles = Array.isArray(metrics.responseCycles) ? metrics.responseCycles : [];
  const breachedCycles = responseCycles.filter((cycle) => cycle.breached);
  breachedCycles.forEach((cycle, index) => metricEvents.push({ id: `metric-art-${cycle.replyId || index}`, at: timelineSeconds(cycle.replyAt) - .1, timelineKind: 'metric', metricTone: 'miss', authorName: `ART breach ${index + 1}`, body: `${formatSeconds(cycle.seconds)} · Missed 90s target for this client-to-agent response cycle` }));
  // Results saved before per-cycle timing was introduced retain the aggregate marker.
  if (!responseCycles.length && metrics.finalMessageAt && Array.isArray(metrics.responseTimes) && metrics.responseTimes.length) metricEvents.push({ id: 'metric-art', at: timelineSeconds(metrics.finalMessageAt) - .1, timelineKind: 'metric', metricTone: metrics.artBreaches ? 'miss' : 'hit', authorName: 'ART', body: `${metrics.artBreaches || 0} of ${metrics.responseTimes.length} response cycles missed the 90s target` });
  if ((metrics.finalHandlingEventAt || metrics.finalMessageAt) && metrics.ahtSeconds != null) metricEvents.push({ id: 'metric-aht', at: timelineSeconds(metrics.finalHandlingEventAt || metrics.finalMessageAt) + .1, timelineKind: 'metric', metricTone: metrics.ahtHit === false ? 'miss' : 'hit', authorName: 'Average AHT', body: `${formatSeconds(metrics.ahtSeconds)} average across ${metrics.ahtMessageCount || metrics.ahtCycles?.length || 1} handling ${Number(metrics.ahtMessageCount || metrics.ahtCycles?.length || 1) === 1 ? 'episode' : 'episodes'} · ${metrics.ahtHit === false ? 'Missed' : 'Met'} ${formatSeconds(metrics.ahtTarget || (metrics.supportLevel === 'level2' ? 300 : 1200))} target · each episode ends at snooze/close` });
  return [...items, ...metricEvents].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
}

function ResultCard({ result, onCompare, onRetry }) {
  if (result.status !== 'completed') return <article className={`audit-result-card ${result.status}`}><div className="result-summary"><div><div className="result-conversation-line"><a href={conversationHref(result)} target="_blank" rel="noreferrer">Conversation {result.conversationId} ↗</a><CopyConversationId value={result.conversationId}/></div><h3>{result.status === 'skipped' ? 'Excluded from scoring' : 'Audit could not complete'}</h3><p>{result.skipReason || result.error}</p></div><div className="failed-result-actions">{result.status === 'failed' && onRetry && <button type="button" onClick={() => onRetry(result.conversationId)}>Retry this audit</button>}<span className="result-state">{result.status}</span></div></div></article>;
  const audit = result.audit || {}; const finalScore = calculatedFinal(audit);
  return <article className="audit-result-card">
    <div className="result-summary">
      <div className="result-agent"><div className="result-conversation-line"><a href={conversationHref(result)} target="_blank" rel="noreferrer">Conversation {result.conversationId} ↗</a><CopyConversationId value={result.conversationId}/>{result.dispute && <span className={`audit-dispute-status ${result.dispute.status}`}>{result.dispute.status === 'pending' ? 'Disputed' : result.dispute.status}</span>}</div><h3>{result.agentName}</h3><p>{audit.primaryIssue || 'Conversation audit'}</p></div>
      <button type="button" className="view-result-button" onClick={() => onCompare(result)}><span>View result</span><i>→</i></button>
      <div className="result-mini-scores"><span className={`score-${Number(audit.quality) >= 8 ? 'good' : Number(audit.quality) >= 6 ? 'watch' : 'risk'}`}><small>Quality</small><b>{audit.quality}</b></span><span className={`score-${Number(audit.efficiency) >= 8 ? 'good' : Number(audit.efficiency) >= 6 ? 'watch' : 'risk'}`}><small>Efficiency</small><b>{audit.efficiency}</b></span><span className={`score-${Number(audit.complexity) >= 8 ? 'good' : Number(audit.complexity) >= 6 ? 'watch' : 'risk'}`}><small>Complexity</small><b>{audit.complexity}</b></span></div>
      <ScoreRing value={finalScore}/>
    </div>
  </article>;
}

function ConversationReviewModal({ state, onClose, onSubmitDispute, onReviewDispute, onEditScore, canReview }) {
  const [previewImage, setPreviewImage] = useState(null); const [editScore, setEditScore] = useState(false); const [scoreDraft, setScoreDraft] = useState({}); const [scoreReason, setScoreReason] = useState(''); const [showDispute, setShowDispute] = useState(false); const [reason, setReason] = useState(''); const [decisionNote, setDecisionNote] = useState(''); const [correction, setCorrection] = useState(''); const [saving, setSaving] = useState(false);
  if (!state) return null;
  const result = state.result || {}; const audit = result.audit || {}; const turns = state.conversation?.turns || []; const deductions = displayDeductions(audit); const finalScore = calculatedFinal(audit); const flags = flagSpecs(audit); const timeline = comparisonTimeline(turns, result); const metrics = result.metrics || {};
  async function submit() { setSaving(true); try { await onSubmitDispute(result, reason); setShowDispute(false); setReason(''); } finally { setSaving(false); } }
  async function review(decision) { setSaving(true); try { await onReviewDispute(result, decision, decisionNote, correction); } finally { setSaving(false); } }
  return <div className="audit-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="audit-comparison-modal" role="dialog" aria-modal="true" aria-label={`Audit and conversation ${result.conversationId}`}>
      <header><div><span>Conversation review</span><h2>{result.agentName} · {result.conversationId}</h2></div><div><CopyConversationId value={result.conversationId}/><a href={conversationHref(result)} target="_blank" rel="noreferrer">Open in Intercom ↗</a><button type="button" onClick={onClose} aria-label="Close comparison">×</button></div></header>
      {state.loading ? <div className="comparison-loading"><StatusOrb state="checking"/><h3>Loading the live Intercom conversation…</h3><p>The transcript is fetched only for this view and is not added to audit history.</p></div> : state.error ? <div className="comparison-loading error"><h3>Could not load the conversation</h3><p>{state.error}</p></div> : <div className="comparison-columns">
        <article className="comparison-verdict"><div className="verdict-scoreboard"><div className="final-score-card"><ScoreRing value={finalScore}/><span>Final score</span><b>({audit.quality} + {audit.efficiency} + {audit.complexity}) ÷ 3 = {finalScore}</b></div><div className="category-score quality"><span>Quality</span><strong>{audit.quality}<small>/10</small></strong><em>−{10 - Number(audit.quality || 0)}</em></div><div className="category-score efficiency"><span>Efficiency</span><strong>{audit.efficiency}<small>/10</small></strong><em>−{10 - Number(audit.efficiency || 0)}</em></div><div className="category-score process"><span>Process</span><strong>{audit.complexity}<small>/10</small></strong><em>−{10 - Number(audit.complexity || 0)}</em></div></div>{canReview && <section className="audit-dispute-panel"><button type="button" onClick={() => { setScoreDraft({ quality: audit.quality, efficiency: audit.efficiency, complexity: audit.complexity }); setEditScore(!editScore); }}>Edit AI Score</button>{editScore && <div className="score-edit-form">{['quality','efficiency','complexity'].map((key) => <label key={key}>{key}<input type="number" min="0" max="10" step="1" value={scoreDraft[key] ?? ''} onChange={(event) => setScoreDraft({ ...scoreDraft, [key]: event.target.value })}/></label>)}<textarea value={scoreReason} onChange={(event) => setScoreReason(event.target.value)} placeholder="Explain the correction (required)"/><button type="button" disabled={saving || scoreReason.trim().length < 10} onClick={async () => { setSaving(true); try { await onEditScore(result, scoreDraft, scoreReason); setEditScore(false); setScoreReason(''); } finally { setSaving(false); } }}>Submit correction</button></div>}{audit.scoreCorrection && <p>Corrected by {audit.scoreCorrection.reviewer}: {audit.scoreCorrection.reason}</p>}</section>}<div className="verdict-overview"><span>AI verdict</span><h3>{audit.primaryIssue}</h3><p>{audit.mainFinding}</p></div><AhtVerification result={result}/><div className="comparison-category quality"><b>Quality · {audit.quality}/10</b><p>{audit.qualityComment}</p></div><div className="comparison-category efficiency"><b>Efficiency · {audit.efficiency}/10</b><p>{audit.efficiencyComment}</p></div><div className="comparison-category process"><b>Process &amp; judgment · {audit.complexity}/10</b><p>{audit.complexityComment}</p></div><div className="modal-deductions"><h4>Why marks were deducted</h4>{deductions.map((item, index) => { const evidenceTarget = deductionEvidenceTarget(item, index, timeline, metrics); return <section className={`deduct-${item.category}`} key={index}><div><b>{item.category}</b><em>−{item.pointsDeducted}</em></div><p>{item.reason}</p>{item.transcriptExample && <small><b>Flagged excerpt:</b> {item.transcriptExample}</small>}{item.betterAction && <small><b>Better action:</b> {item.betterAction}</small>}<button type="button" className="deduction-evidence-link" onClick={() => jumpToEvidence(evidenceTarget)}>View evidence in conversation ↓</button></section>; })}{!deductions.length && <p>No deductions recorded.</p>}</div>{(audit.accuracyIssues || []).map((item, index) => <div className="modal-accuracy" key={index}><b>Accuracy correction</b><p><strong>Shared:</strong> {item.wrongInformation}</p><p><strong>Correct:</strong> {item.correctInformation}</p>{item.evidenceUrl && <a href={item.evidenceUrl} target="_blank" rel="noreferrer">Open source ↗</a>}</div>)}<section className="audit-dispute-panel"><div><b>Audit dispute</b>{result.dispute && <span className={`audit-dispute-status ${result.dispute.status}`}>{result.dispute.status === 'pending' ? 'Disputed' : result.dispute.status}</span>}</div>{result.dispute ? <><p>{result.dispute.reason}</p>{result.dispute.reviewerNote && <small><b>Decision note:</b> {result.dispute.reviewerNote}</small>}{result.dispute.correction && <small><b>Approved audit guidance:</b> {result.dispute.correction}</small>}{canReview && result.dispute.status === 'pending' && <div className="audit-dispute-review"><textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} placeholder="Decision note for the agent"/><textarea value={correction} onChange={(event) => setCorrection(event.target.value)} placeholder="Correct audit guidance (required to approve)"/><div><button disabled={saving} onClick={() => review('rejected')}>Reject</button><button className="approve" disabled={saving || correction.trim().length < 20} onClick={() => review('approved')}>Approve &amp; save audit guidance</button></div></div>}</> : showDispute ? <div className="audit-dispute-form"><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain what the audit got wrong and what should be reconsidered."/><div><button onClick={() => setShowDispute(false)}>Cancel</button><button className="approve" disabled={saving || reason.trim().length < 10} onClick={submit}>Submit dispute</button></div></div> : <><p>Agents and leads can ask for a manual review of this result.</p><button className="open-dispute" onClick={() => setShowDispute(true)}>Dispute this audit</button></>}</section></article>
        <article className="comparison-transcript" id={turnDomId('transcript')}><div className="transcript-heading"><div><span>Live Intercom transcript</span><div className="transcript-legend"><i className="client"/>Client<i className="ai"/>FundedNext AI<i className="agent"/>Agent<i className="internal-note"/>Internal note<i className="event"/>Event</div></div><b>{turns.filter((turn) => turn.body && !/^\[/.test(turn.body)).length} messages</b></div>{timeline.map((turn) => { const matched = turn.timelineKind === 'agent' ? matchedFlags(turn.body, flags) : []; const event = turn.timelineKind === 'event'; const body = event ? readableEvent(turn.body || turn.partType) : turn.body || `[${turn.partType}]`; return <div id={turnDomId(turn.id)} key={turn.id} className={`transcript-turn ${turn.timelineKind} ${turn.metricTone || ''} ${matched.length ? `flagged flag-border-${matched[0].category}` : ''}`}><div><b>{turn.timelineKind === 'bot' ? 'FundedNext AI' : turn.timelineKind === 'internal-note' ? 'Internal note · not visible to client' : event ? 'Intercom event' : turn.authorName}</b><time>{formatDate(new Date(turn.at * 1000).toISOString())}</time></div><div className="transcript-message"><TranscriptBody text={body} flags={flags} highlight={turn.timelineKind === 'agent'}/></div>{(turn.attachments || []).length > 0 && <div className="transcript-attachments">{turn.attachments.map((attachment) => (/^image\//i.test(attachment.mimeType || '') || /\.(?:png|jpe?g|gif|webp)(?:\?|$)/i.test(attachment.url)) ? <button type="button" key={attachment.id || attachment.url} onClick={() => setPreviewImage(attachment)} aria-label={`Preview ${attachment.name || 'image'}`}><img src={attachment.url} loading="lazy" alt={attachment.name || 'Conversation attachment'}/></button> : <a key={attachment.id || attachment.url} href={attachment.url} target="_blank" rel="noreferrer"><span>↗ {attachment.name || 'Open attachment'}</span></a>)}</div>}{matched.length > 0 && <small className="flag-reason">Referenced in verdict · {matched.map((item) => item.label).join(' · ')}</small>}</div>; })}</article>
      </div>}
    </section>
    {previewImage && <div className="attachment-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewImage(null); }}><div className="attachment-preview" role="dialog" aria-modal="true" aria-label="Image preview"><button type="button" onClick={() => setPreviewImage(null)} aria-label="Close image preview">×</button><img src={previewImage.url} alt={previewImage.name || 'Conversation attachment'}/></div></div>}
  </div>;
}

export default function Audits() {
  const [theme, setTheme] = useState('dark');
  const [session, setSession] = useState('');
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState('control');
  const [conversationIds, setConversationIds] = useState('');
  const [selectedAgents, setSelectedAgents] = useState([]);
  const [agentSearch, setAgentSearch] = useState(''); const [perAgent, setPerAgent] = useState(false);
  const [from, setFrom] = useState(today(-6));
  const [to, setTo] = useState(today());
  const [sampleSize, setSampleSize] = useState(10);
  const [customSample, setCustomSample] = useState('');
  const [currentJob, setCurrentJob] = useState(null);
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [syncingAgents, setSyncingAgents] = useState(false);
  const [enabledDraft, setEnabledDraft] = useState([]);
  const [level2Draft, setLevel2Draft] = useState([]);
  const [adminAgentSearch, setAdminAgentSearch] = useState('');
  const [accessDraft, setAccessDraft] = useState('');
  const [selfAccessDraft, setSelfAccessDraft] = useState('');
  const [modelsDraft, setModelsDraft] = useState('');
  const [thresholdDraft, setThresholdDraft] = useState({ standard: { frtSeconds: 30, artSeconds: 90, ahtSeconds: 1200 }, level2: { frtSeconds: 30, artSeconds: 90, ahtSeconds: 300 } });
  const [savingAdmin, setSavingAdmin] = useState('');
  const [developerKeyName, setDeveloperKeyName] = useState('Codex testing');
  const [developerKeyDays, setDeveloperKeyDays] = useState('7');
  const [revealedDeveloperKey, setRevealedDeveloperKey] = useState('');
  const [developerConnection, setDeveloperConnection] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [selectedHistoryJobs, setSelectedHistoryJobs] = useState([]);
  const [deletingHistory, setDeletingHistory] = useState(false);
  const stopRef = useRef(false);
  const processingRef = useRef(false);
  const directMode = conversationIds.trim().length > 0;

  const headers = (json = false) => ({ ...(json ? { 'Content-Type': 'application/json' } : {}), 'x-app-session': session });
  const enabledAgents = useMemo(() => (data?.agents || []).filter((agent) => (data?.enabledAgentIds || []).includes(agent.id)), [data]);
  const visibleAgents = useMemo(() => enabledAgents.filter((agent) => `${agent.name} ${agent.email}`.toLowerCase().includes(agentSearch.toLowerCase())), [enabledAgents, agentSearch]);
  const adminVisibleAgents = useMemo(() => {
    const query = adminAgentSearch.trim().toLowerCase();
    if (!query) return data?.agents || [];
    return (data?.agents || []).filter((agent) => `${agent.name || ''} ${agent.email || ''} ${agent.id || ''}`.toLowerCase().includes(query));
  }, [data?.agents, adminAgentSearch]);
  const completedResults = results.filter((item) => item.status === 'completed');

  useEffect(() => {
    const saved = localStorage.getItem('theme') || 'light'; setTheme(saved); document.documentElement.setAttribute('data-theme', saved);
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); localStorage.setItem('theme', next); document.documentElement.setAttribute('data-theme', next);
  }

  useEffect(() => {
    const token = localStorage.getItem('appSession') || '';
    setSession(token);
    if (!token) { setLoading(false); return; }
    bootstrap(token);
    return () => { stopRef.current = true; };
  }, []);

  useEffect(() => {
    if (!running) { setElapsed(0); return; }
    const started = Date.now(); const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);

  async function request(action, body = {}, token = session) {
    const response = await fetch('/api/audits', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session': token }, body: JSON.stringify({ action, ...body }) });
    const result = await response.json();
    if (response.status === 401) { localStorage.removeItem('appSession'); setSession(''); }
    if (!response.ok) throw new Error(result.error || 'Audit request failed.');
    return result;
  }

  async function bootstrap(token = session) {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/audits?action=bootstrap', { headers: { 'x-app-session': token } });
      const result = await response.json();
      if (!response.ok) { if (response.status === 403) setAccessDenied(true); throw new Error(result.error || 'Could not load Conversation Audit.'); }
      setData(result); setSelectedAgents([]); setEnabledDraft(result.enabledAgentIds || []); setLevel2Draft(result.level2AgentIds || []); setThresholdDraft(result.thresholds);
      setAccessDraft((result.access?.config?.emails || []).join('\n')); setSelfAccessDraft((result.access?.selfConfig?.emails || []).join('\n')); setModelsDraft((result.models || []).join('\n'));
      if (result.access?.permission === 'self' || new URLSearchParams(window.location.search).get('view') === 'history') setView('history');
      const active = (result.jobs || []).find((job) => ['queued','running','paused'].includes(job.status));
      if (active && result.access?.canRun) await loadJob(active.id, token);
      if (result.access?.canRun) checkHealth(token); else setHealth({ state: 'healthy', checkedAt: new Date().toISOString(), intercom: { connected: true, detail: 'My Audits access ready' }, gemini: [], healthyGeminiKeys: 0 });
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  async function checkHealth(token = session) {
    setHealth({ state: 'checking', checkedAt: null, intercom: { detail: 'Checking Intercom…' }, gemini: [], healthyGeminiKeys: 0 });
    try { const result = await request('health', {}, token); setHealth(result.health); }
    catch (err) { setHealth({ state: 'offline', checkedAt: new Date().toISOString(), intercom: { connected: false, detail: err.message }, gemini: [], healthyGeminiKeys: 0 }); }
  }

  async function loadJob(id, token = session) {
    setError('');
    try {
      const response = await fetch(`/api/audits?action=job&id=${encodeURIComponent(id)}`, { headers: { 'x-app-session': token } });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not load this audit.');
      setCurrentJob(result.job); setResults(result.results || []); setView('results');
      if (['queued','running'].includes(result.job.status) && !result.job.pauseRequested) runQueue(result.job.id, token);
    } catch (err) { setError(err.message); }
  }

  async function startAudit() {
    if (!directMode && !selectedAgents.length) return setError('Select at least one agent or enter specific conversation IDs.');
    setError(''); setNotice(''); setRunning(true); stopRef.current = false; setResults([]); setCurrentJob(null); setView('results');
    try {
      const size = customSample ? Number(customSample) : sampleSize;
      const result = await request('create-job', { conversationIds, agentIds: selectedAgents, from, to, sampleSize: size, perAgent: selectedAgents.length > 1 && perAgent });
      setCurrentJob(result.job); setView('results');
      await runQueue(result.job.id);
      await bootstrap(session);
    } catch (err) { setError(err.message); setRunning(false); setView('control'); }
  }

  async function retryConversation(conversationId) {
    if (!conversationId || running) return;
    setError(''); setNotice('Retrying this conversation in a fresh audit batch…'); setRunning(true); stopRef.current = false; setCurrentJob(null); setResults([]); setView('results');
    try {
      const result = await request('create-job', { conversationIds: String(conversationId) });
      setCurrentJob(result.job); setResults([]); setView('results');
      await runQueue(result.job.id);
      await bootstrap(session);
    } catch (err) { setError(err.message); setRunning(false); }
  }

  async function runQueue(jobId, token = session) {
    if (processingRef.current) return;
    processingRef.current = true;
    setRunning(true); stopRef.current = false;
    try {
      while (!stopRef.current) {
        const result = await request('process-next', { jobId }, token);
        setCurrentJob(result.job);
        if (result.results?.length) setResults((current) => [...current, ...result.results]);
        if (result.processed && result.processed.status !== 'completed') {
          const fresh = await fetch(`/api/audits?action=job&id=${encodeURIComponent(jobId)}`, { headers: { 'x-app-session': token } }).then((response) => response.json());
          if (fresh.results) setResults(fresh.results);
        }
        if (['completed','cancelled'].includes(result.job?.status) || result.done) break;
        if (result.retryAfterMs) await new Promise((resolve) => setTimeout(resolve, Math.min(result.retryAfterMs, 30000)));
        else await new Promise((resolve) => setTimeout(resolve, 350));
      }
    } catch (err) { setError(err.message); }
    finally { processingRef.current = false; setRunning(false); }
  }

  async function pauseAudit() {
    if (!currentJob?.id) return;
    stopRef.current = true; setNotice('Pause requested. The current conversation will finish saving, then the batch will stop.');
    try { const result = await request('pause-job', { jobId: currentJob.id }); setCurrentJob(result.job); }
    catch (err) { setError(err.message); }
  }

  async function resumeAudit() {
    if (!currentJob?.id || running) return;
    setError(''); setNotice('Resuming from the next saved checkpoint…'); stopRef.current = false;
    try { const result = await request('resume-job', { jobId: currentJob.id }); setCurrentJob(result.job); await runQueue(result.job.id); }
    catch (err) { setError(err.message); setRunning(false); }
  }

  async function cancelAudit() {
    if (!currentJob?.id || currentJob.status === 'completed' || currentJob.status === 'cancelled') return;
    if (!window.confirm('Cancel this audit batch? Completed results will remain saved, but unprocessed conversations will not run.')) return;
    stopRef.current = true; setNotice('Cancelling the audit. Completed results remain saved.');
    try { const result = await request('cancel-job', { jobId: currentJob.id }); setCurrentJob(result.job); setRunning(false); }
    catch (err) { setError(err.message); }
  }

  async function deleteSelectedHistory() {
    const jobs = (data?.jobs || []).filter((job) => selectedHistoryJobs.includes(String(job.id)));
    if (!jobs.length || deletingHistory) return;
    const evaluations = jobs.reduce((sum, job) => sum + Number(job.evaluations || 0), 0);
    if (!window.confirm(`Permanently delete ${jobs.length} audit batch${jobs.length === 1 ? '' : 'es'} and ${evaluations} saved evaluation${evaluations === 1 ? '' : 's'}? The saved scores, feedback, evidence references, and timing details will be removed. This cannot be undone.`)) return;
    setDeletingHistory(true); setError('');
    try {
      const result = await request('delete-jobs', { jobIds: jobs.map((job) => job.id) });
      setData((current) => ({ ...current, jobs: (current.jobs || []).filter((job) => !result.jobIds.map(String).includes(String(job.id))) }));
      setSelectedHistoryJobs([]); setNotice(`Deleted ${result.deletedJobs} audit batch${result.deletedJobs === 1 ? '' : 'es'} and ${result.deletedResults} saved result${result.deletedResults === 1 ? '' : 's'}.`);
    } catch (err) { setError(err.message); }
    finally { setDeletingHistory(false); }
  }

  async function syncAgents() {
    setSyncingAgents(true); setError('');
    try { const result = await request('sync-agents'); setData((current) => ({ ...current, agents: result.agents, enabledAgentIds: result.enabledAgentIds, level2AgentIds: result.level2AgentIds })); setEnabledDraft(result.enabledAgentIds); setLevel2Draft(result.level2AgentIds || []); setNotice(`Intercom connected · ${result.agents.length} agents found.`); }
    catch (err) { setError(err.message); } finally { setSyncingAgents(false); }
  }

  async function saveAdmin(action, payload, success) {
    setSavingAdmin(action); setError('');
    try {
      const result = await request(action, payload); setNotice(success);
      if (result.enabledAgentIds) { setData((current) => ({ ...current, enabledAgentIds: result.enabledAgentIds, level2AgentIds: result.level2AgentIds || current.level2AgentIds || [] })); setEnabledDraft(result.enabledAgentIds); setLevel2Draft(result.level2AgentIds || []); }
      if (result.access) setData((current) => ({ ...current, access: { ...current.access, config: result.access } }));
      if (result.models) setData((current) => ({ ...current, models: result.models }));
      if (result.thresholds) { setData((current) => ({ ...current, thresholds: result.thresholds })); setThresholdDraft(result.thresholds); }
    } catch (err) { setError(err.message); } finally { setSavingAdmin(''); }
  }

  async function createDeveloperKey() {
    setSavingAdmin('create-external-key'); setError(''); setDeveloperConnection(null);
    try {
      const result = await request('create-external-key', { name: developerKeyName, expiresInDays: Number(developerKeyDays), scopes: data.developerScopes || [] });
      setData((current) => ({ ...current, developerKeys: result.keys })); setRevealedDeveloperKey(result.key);
      const response = await fetch('/api/external/health', { headers: { Authorization: `Bearer ${result.key}` } });
      const healthResult = await response.json();
      setDeveloperConnection({ connected: response.ok && healthResult.connected, detail: response.ok ? `Connected · ${healthResult.knowledge?.articles || 0} FAQs visible · ${healthResult.knowledge?.activeNotices || 0} active Notices` : healthResult.error });
      setNotice('Developer API key created and tested. Copy it now; the full key will not be shown again.');
    } catch (err) { setError(err.message); } finally { setSavingAdmin(''); }
  }

  async function revokeDeveloperKey(id) {
    setSavingAdmin(`revoke-${id}`); setError('');
    try { const result = await request('revoke-external-key', { id }); setData((current) => ({ ...current, developerKeys: result.keys })); setNotice('Developer API key revoked.'); }
    catch (err) { setError(err.message); } finally { setSavingAdmin(''); }
  }

  async function download(format, detailed = false) {
    if (!currentJob) return;
    setNotice('Preparing your download…');
    try {
      const response = await fetch(`/api/audits?action=export&jobId=${currentJob.id}&format=${format}${detailed ? '&detailed=1' : ''}`, { headers: headers() });
      if (!response.ok) { const problem = await response.json(); throw new Error(problem.error || 'Download failed.'); }
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a');
      const base = auditDownloadBase(currentJob, results);
      link.href = url; link.download = `${base}${format === 'csv' ? (detailed ? '-detailed' : '-summary') : ''}.${format}`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`${format.toUpperCase()} report downloaded.`);
    } catch (err) { setError(err.message); }
  }

  async function openComparison(result) {
    setComparison({ result, loading: true, conversation: null, error: '' });
    try {
      const response = await request('conversation-view', { conversationId: result.conversationId });
      setComparison({ result, loading: false, conversation: response.conversation, error: '' });
    } catch (err) {
      setComparison({ result, loading: false, conversation: null, error: err.message });
    }
  }

  function mergeDispute(resultId, dispute) {
    setResults((current) => current.map((item) => String(item.id) === String(resultId) ? { ...item, dispute } : item));
    setComparison((current) => current?.result && String(current.result.id) === String(resultId) ? { ...current, result: { ...current.result, dispute } } : current);
  }

  async function submitAuditDispute(result, reason) {
    setError('');
    try { const response = await request('submit-dispute', { resultId: result.id, reason }); mergeDispute(result.id, response.dispute); setNotice('Audit dispute submitted for review.'); }
    catch (err) { setError(err.message); throw err; }
  }

  async function reviewAuditDispute(result, decision, reviewerNote, correction) {
    setError('');
    try { const response = await request('review-dispute', { disputeId: result.dispute?.id, decision, reviewerNote, correction }); mergeDispute(result.id, response.dispute); setData((current) => ({ ...current, auditDisputes: (current.auditDisputes || []).map((item) => String(item.id) === String(response.dispute.id) ? { ...item, ...response.dispute } : item), auditSnippets: response.snippet ? [response.snippet, ...(current.auditSnippets || [])] : current.auditSnippets })); setNotice(decision === 'approved' ? `Dispute approved after checking current FAQ and Notice evidence. ${(response.snippet?.evidence || []).length} references were saved with the audit snippet.` : 'Dispute rejected and the agent can now see the decision.'); }
    catch (err) { setError(err.message); throw err; }
  }

  async function openAuditDispute(dispute) {
    setError('');
    try {
      const response = await fetch(`/api/audits?action=job&id=${encodeURIComponent(dispute.jobId)}`, { headers: headers() });
      const loaded = await response.json(); if (!response.ok) throw new Error(loaded.error || 'Could not open the disputed audit.');
      const target = (loaded.results || []).find((item) => String(item.id) === String(dispute.resultId));
      if (!target) throw new Error('The disputed result is no longer available.');
      setCurrentJob(loaded.job); setResults(loaded.results || []); setView('results'); await openComparison(target);
    } catch (err) { setError(err.message); }
  }

  async function editAuditScore(result, scores, reason) {
    try {
      const response = await request('edit-ai-score', { resultId: result.id, scores, reason });
      setResults((current) => current.map((item) => String(item.id) === String(result.id) ? response.result : item));
      setComparison((current) => current ? { ...current, result: response.result } : current);
      setNotice(response.snippetActive ? 'Score correction saved and audit guidance added.' : 'Score correction saved. The snippet is inactive because no supporting FAQ or Notice was found.');
      await bootstrap();
    } catch (err) { setError(err.message); throw err; }
  }

  async function saveAuditSnippet(snippet, updates) {
    setSavingAdmin(`snippet-${snippet.id}`); setError('');
    try { await request('update-audit-snippet', { id: snippet.id, ...updates }); await bootstrap(); setView('snippets'); setNotice('Audit snippet updated. Future audits will use the saved guidance.'); }
    catch (err) { setError(err.message); } finally { setSavingAdmin(''); }
  }

  async function deleteAuditSnippet(snippet) {
    if (!window.confirm(`Delete “${snippet.title || `Audit snippet #${snippet.id}`}” permanently? Future audits will stop using this guidance.`)) return;
    setSavingAdmin(`snippet-${snippet.id}`); setError('');
    try { await request('delete-audit-snippet', { id: snippet.id }); await bootstrap(); setView('snippets'); setNotice('Audit snippet deleted.'); }
    catch (err) { setError(err.message); } finally { setSavingAdmin(''); }
  }

  if (!session) return <main className="audit-login"><Logo/><h1>Conversation Audit</h1><p>Sign in through the FundedNext Support Assistant, then return here.</p><Link className="btn btn-primary" href="/">Go to sign in</Link></main>;
  if (loading) return <AuditLaunchLoader />;
  if (accessDenied) return <main className="audit-login"><Logo/><h1>Audit access is restricted</h1><p>{error || 'A Master Admin can grant your @nextventures.io account access from Audit settings.'}</p><Link className="btn btn-primary" href="/">Back to Support Assistant</Link></main>;

  const progress = currentJob?.total ? Math.round((currentJob.processed / currentJob.total) * 100) : 0;
  const avg = (key) => completedResults.length ? (completedResults.reduce((sum, item) => sum + (key === 'finalScore' ? calculatedFinal(item.audit) : Number(item.audit?.[key] || 0)), 0) / completedResults.length).toFixed(2) : '—';

  return <>
    <Head><title>Conversation Audit · FundedNext</title></Head>
    <div className="audit-shell">
      <aside className="audit-sidebar">
        <div className="audit-brand"><Logo/><div><b>FundedNext</b><span>Conversation Audit</span></div></div>
        <nav>
          {data?.access?.canRun && <button className={view === 'control' ? 'active' : ''} onClick={() => setView('control')}><i>⌁</i><span>Audit control</span></button>}
          <button className={view === 'results' ? 'active' : ''} onClick={() => setView('results')}><i>▤</i><span>Results</span>{results.length > 0 && <em>{results.length}</em>}</button>
          <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}><i>◷</i><span>Audit history</span></button>
          {data?.access?.canReviewDisputes && <button className={view === 'disputes' ? 'active' : ''} onClick={() => setView('disputes')}><i>⚑</i><span>Disputes</span>{data.auditDisputes?.filter((item) => item.status === 'pending').length > 0 && <em>{data.auditDisputes.filter((item) => item.status === 'pending').length}</em>}</button>}
          {data?.access?.canReviewDisputes && <button className={view === 'snippets' ? 'active' : ''} onClick={() => setView('snippets')}><i>⌘</i><span>Audit snippets</span>{data.auditSnippets?.filter((item) => item.active !== false).length > 0 && <em>{data.auditSnippets.filter((item) => item.active !== false).length}</em>}</button>}
          {data?.access?.canManage && <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}><i>⚙</i><span>Audit settings</span></button>}
        </nav>
        <div className="sidebar-health"><StatusOrb state={health?.state || 'checking'}/><div><b>{data?.access?.permission === 'self' ? 'My Audits ready' : health?.state === 'healthy' ? 'Systems connected' : health?.state === 'degraded' ? 'Fallback available' : health?.state === 'offline' ? 'Connection needed' : 'Checking systems'}</b><small>{data?.access?.permission === 'self' ? 'Private results matched by email' : `${health?.healthyGeminiKeys || 0} Gemini keys healthy`}</small></div></div>
        <div className="audit-side-foot"><Link href="/">← Support assistant</Link>{data?.access?.canManage && <Link href="/admin">Admin console</Link>}</div>
      </aside>

      <main className="audit-main">
        <header className="audit-topbar"><div><span className="eyebrow">Customer Experience Intelligence</span><h1>{view === 'control' ? 'Audit conversations' : view === 'results' ? 'Audit results' : view === 'history' ? (data?.access?.permission === 'self' ? 'My Audits' : 'Audit history') : view === 'disputes' ? 'Audit disputes' : view === 'snippets' ? 'Audit snippets' : 'Audit settings'}</h1></div><div className="audit-top-actions"><button className="theme-toggle" onClick={toggleTheme} aria-label="Change theme"><span>{theme === 'dark' ? '☀' : '☾'}</span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>{data?.access?.canRun && <button className="health-refresh" onClick={() => checkHealth()}><span className={health?.state === 'checking' ? 'spin' : ''}>↻</span> Check connections</button>}</div></header>
        {error && <div className="audit-alert error"><b>Action needed</b><span>{error}</span><button onClick={() => setError('')}>×</button></div>}
        {notice && <div className="audit-alert success"><b>Done</b><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}

        {view === 'control' && data?.access?.canRun && <div className="audit-control-layout">
          <section className="audit-card connection-card">
            <div className="card-heading"><div><span>Live readiness</span><h2>Connections and capacity <AuditTip text="Shows whether Intercom, the Gemini key pool, and saved knowledge are ready before an audit starts."/></h2><p>Live checks use harmless test requests and never send a customer conversation.</p></div><StatusOrb state={health?.state || 'checking'}/></div>
            <div className="connection-grid">
              <div className={health?.intercom?.connected ? 'connected' : health?.state === 'checking' ? 'checking' : 'disconnected'}><ConnectionLogo type="intercom" state={health?.intercom?.connected ? 'connected' : health?.state === 'checking' ? 'checking' : 'disconnected'}/><span><b>Intercom</b><small>{health?.intercom?.detail || 'Checking connection…'}</small></span></div>
              <div className={(health?.healthyGeminiKeys || 0) > 0 ? 'connected' : health?.state === 'checking' ? 'checking' : 'disconnected'}><ConnectionLogo type="gemini" state={(health?.healthyGeminiKeys || 0) > 0 ? 'connected' : health?.state === 'checking' ? 'checking' : 'disconnected'}/><span><b>Gemini pool</b><small>{health?.state === 'checking' ? 'Testing saved keys…' : `${health?.healthyGeminiKeys || 0} of ${health?.gemini?.length ?? data?.connection?.geminiKeyCount ?? 0} keys ready`}</small></span></div>
              <div className="connected"><ConnectionLogo type="knowledge" state="connected"/><span><b>Knowledge</b><small>Live FAQs, Notices and corrections</small></span></div>
            </div>
          </section>

          <section className={`audit-card direct-card ${directMode ? 'engaged' : ''}`}>
            <div className="card-heading"><div><span>Direct audit</span><h2>Specific conversation IDs <AuditTip text="Audits only the IDs entered here. Agent, date, and sample controls are ignored while this field contains an ID."/></h2><p>Enter one or multiple Intercom conversation IDs separated by commas or new lines.</p></div>{directMode && <b className="override-pill">Override active</b>}</div>
            <textarea value={conversationIds} onChange={(event) => setConversationIds(event.target.value)} placeholder={'Paste one or more real Intercom conversation IDs here…'} rows={4}/>
            {directMode && <div className="override-note"><i>↳</i><span><b>Direct conversation mode</b>Agent, date and priority-sample filters below will be ignored.</span></div>}
          </section>

          <div className={`sample-controls ${directMode ? 'disabled' : ''}`} aria-disabled={directMode}>
            <section className="audit-card agent-card">
              <div className="card-heading"><div><span>Step 1</span><h2>Select agents <AuditTip text="Choose whose conversations can enter this batch. No agent is selected automatically."/></h2><p>{selectedAgents.length} selected from {enabledAgents.length} enabled agents.</p></div><button onClick={() => setSelectedAgents(selectedAgents.length === enabledAgents.length ? [] : enabledAgents.map((agent) => agent.id))}>{selectedAgents.length === enabledAgents.length ? 'Clear all' : 'Select all'}</button></div>
              <input className="agent-search" value={agentSearch} onChange={(event) => setAgentSearch(event.target.value)} placeholder="Search agents…"/>
              {selectedAgents.length > 0 && <div className="selected-agent-chips" aria-label="Selected agents">{enabledAgents.filter((agent) => selectedAgents.includes(agent.id)).map((agent) => <button type="button" key={agent.id} onClick={() => setSelectedAgents((current) => current.filter((id) => id !== agent.id))} aria-label={`Remove ${agent.name}`}>{agent.name} <span aria-hidden="true">×</span></button>)}</div>}
              <div className="agent-picker">{visibleAgents.map((agent) => <label key={agent.id} className={selectedAgents.includes(agent.id) ? 'selected' : ''}><input type="checkbox" checked={selectedAgents.includes(agent.id)} onChange={() => setSelectedAgents((current) => current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id])}/><span className="agent-avatar">{agent.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('')}</span><span><b>{agent.name}</b><small>{agent.email || `Intercom ID ${agent.id}`}</small></span><i>✓</i></label>)}</div>
            </section>
            <section className="audit-card sample-card">
              <div className="card-heading"><div><span>Step 2</span><h2>Choose the sample <AuditTip text="The date range limits eligible conversations; the requested sample size is shared across all selected agents."/></h2><p>Bot-only chats are excluded, then the conversations with the most messages from each selected agent are prioritized.</p></div></div>
              <AuditDateRangeFilter from={from} to={to} onApply={(nextFrom, nextTo) => { setFrom(nextFrom); setTo(nextTo); }}/>
              {selectedAgents.length > 1 && <label className="sample-label"><input type="checkbox" checked={perAgent} onChange={(event) => setPerAgent(event.target.checked)}/> Request this number of conversations for each selected agent (maximum 100 total)</label>}
              <label className="sample-label">Priority conversations <AuditTip text="The auditor favors conversations with the most messages written by the selected agent because they provide more evidence of handling skill."/></label>
              <div className="sample-options">{[10,20,30,40].map((value) => <button key={value} className={!customSample && sampleSize === value ? 'active' : ''} onClick={() => { setSampleSize(value); setCustomSample(''); }}>{value}</button>)}<label className={customSample ? 'active' : ''}><span>Custom</span><input type="number" min="1" max="100" value={customSample} onChange={(event) => setCustomSample(event.target.value)} placeholder="50"/></label></div>
              <div className="sampling-note"><i>⌁</i><span><b>Insight-first selection <AuditTip text="Selection is based on the selected agent's own meaningful replies, not total bot or customer message volume."/></b>The auditor compares a broad candidate pool and selects the conversations with the highest message count from the chosen agent. Recent conversations break ties.</span></div>
            </section>
          </div>
          <section className="launch-card"><div><span>Ready when you are</span><h2>{directMode ? `${conversationIds.split(/[\s,]+/).filter(Boolean).length} specific conversation${conversationIds.split(/[\s,]+/).filter(Boolean).length === 1 ? '' : 's'}` : `${customSample || sampleSize} priority conversations across ${selectedAgents.length} agent${selectedAgents.length === 1 ? '' : 's'}`}</h2><p>Audits are saved after every conversation and can safely resume after a refresh.</p></div><div className="launch-action"><AuditTip text="Creates a saved batch and processes one conversation at a time. Progress survives refreshes and can be paused or cancelled."/><button className="launch-button" disabled={running || health?.state === 'offline'} onClick={startAudit}><span>{running ? 'Auditing…' : 'Start audit'}</span><i>{running ? '◌' : '→'}</i></button></div></section>
        </div>}

        {view === 'results' && <div className="audit-results-page">
          {currentJob ? <>
            <section className={`audit-progress-card ${running ? 'running' : ''}`}>
              <div className="progress-visual"><div className="progress-orbit"><i/><i/><b>{currentJob.status === 'completed' ? '✓' : 'QA'}</b></div></div>
              <div className="progress-copy"><span>Batch #{currentJob.id} · {currentJob.mode === 'direct' ? 'Direct conversation audit' : 'Priority sample'}</span><h2>{currentJob.stage || 'Preparing audit'}</h2><p>{currentJob.status === 'completed' ? `Completed ${formatDate(currentJob.updatedAt)}` : currentJob.status === 'failed' ? currentJob.error : `${elapsed}s in this session · every selection checkpoint and result is saved`}</p><div className="progress-track"><i style={{ width: `${Math.max(currentJob.selection?.checked ? Math.round((currentJob.selection.checked / Math.max(1,currentJob.selection.available)) * 12) : currentJob.processed ? 4 : 0, progress)}%` }}/></div><small>{currentJob.selection && currentJob.processed === 0 ? `Checked ${currentJob.selection.checked} of ${currentJob.selection.available} candidates · selecting ${currentJob.selection.requested}` : `${currentJob.processed} of ${currentJob.total} conversations · ${progress}%`}</small></div>
              <div className="progress-actions">{data?.access?.canRun && running && <><span><AuditTip text="Stops after the current conversation is safely saved. The batch remains resumable on any device."/><button onClick={pauseAudit}>Pause safely</button></span><span><AuditTip text="Stops the remaining queue permanently. Results already completed stay saved."/><button className="danger" onClick={cancelAudit}>Cancel audit</button></span></>}{data?.access?.canRun && !running && currentJob.status === 'paused' && <><span><AuditTip text="Continues from the next saved checkpoint in this batch."/><button onClick={resumeAudit}>Resume audit</button></span><span><AuditTip text="Stops the remaining queue permanently. Results already completed stay saved."/><button className="danger" onClick={cancelAudit}>Cancel audit</button></span></>}{data?.access?.canRun && !running && ['completed','cancelled','failed'].includes(currentJob.status) && <button onClick={() => { setView('control'); setCurrentJob(null); setResults([]); setSelectedAgents([]); }}>New audit</button>}</div>
            </section>
            <div className="audit-kpis"><Metric label="Completed chats" value={currentJob.completed}/><Metric label="Agent evaluations" value={currentJob.evaluations}/><Metric label="Average quality" value={avg('quality')}/><Metric label="Average efficiency" value={avg('efficiency')}/><Metric label="Average final" value={avg('finalScore')} tone="accent"/><Metric label="Manual review" value={completedResults.filter((item) => item.audit?.manualReview).length}/></div>
            <section className="results-toolbar"><div><h2>Conversation evaluations</h2><p>{results.length} saved result{results.length === 1 ? '' : 's'} in this batch.</p></div><div><button onClick={() => download('csv')}>⇩ Summary CSV</button><button onClick={() => download('csv', true)}>⇩ Detailed CSV</button><button className="primary" onClick={() => download('html')}>⇩ HTML report</button></div></section>
            <div className="audit-result-list">{results.map((result) => <ResultCard key={result.id || `${result.conversationId}-${result.agentId}-${result.status}`} result={result} onCompare={openComparison} onRetry={data?.access?.canRun ? retryConversation : null}/>)}{!results.length && <div className="empty-results"><StatusOrb state={running ? 'checking' : 'offline'}/><h3>{running ? 'The first conversation is being prepared' : 'No results saved yet'}</h3><p>Live status and the first scored result will appear here automatically.</p></div>}</div>
          </> : running ? <AuditBatchPreparation elapsed={elapsed} direct={directMode} requested={directMode ? conversationIds.split(/[\s,]+/).filter(Boolean).length : Number(customSample || sampleSize)}/> : <div className="empty-results large"><span>▤</span><h2>No audit selected</h2><p>Start a new audit or open one from Audit history.</p><button onClick={() => setView('control')}>Open audit control</button></div>}
        </div>}

        {view === 'history' && <div className="audit-history"><section className="audit-card"><div className="card-heading"><div><span>Saved securely</span><h2>{data?.access?.permission === 'self' ? 'My Audits' : 'Recent audit batches'}</h2><p>{data?.access?.permission === 'self' ? 'Only results matched to your verified Intercom email appear here.' : 'Each batch stores structured scores, feedback, evidence references, and timing details. Raw Intercom transcripts and temporary identity mappings are not stored.'}</p></div><div className="history-heading-actions"><button onClick={() => bootstrap()}>Refresh</button>{data?.access?.canManage && <button className="history-delete" disabled={!selectedHistoryJobs.length || deletingHistory} onClick={deleteSelectedHistory}>{deletingHistory ? 'Deleting…' : `Delete selected${selectedHistoryJobs.length ? ` (${selectedHistoryJobs.length})` : ''}`}</button>}</div></div>{data?.access?.canManage && !!(data?.jobs || []).length && <div className="history-selection-bar"><label><input type="checkbox" checked={(data.jobs || []).filter((job) => !['queued','running','paused'].includes(job.status)).length > 0 && (data.jobs || []).filter((job) => !['queued','running','paused'].includes(job.status)).every((job) => selectedHistoryJobs.includes(String(job.id)))} onChange={(event) => setSelectedHistoryJobs(event.target.checked ? (data.jobs || []).filter((job) => !['queued','running','paused'].includes(job.status)).map((job) => String(job.id)) : [])}/> Select all finished batches</label><small>{selectedHistoryJobs.length ? `${selectedHistoryJobs.length} batch${selectedHistoryJobs.length === 1 ? '' : 'es'} selected · ${(data.jobs || []).filter((job) => selectedHistoryJobs.includes(String(job.id))).reduce((sum, job) => sum + Number(job.evaluations || 0), 0)} saved evaluations` : 'Select completed or cancelled batches for permanent deletion'}</small></div>}<div className="history-list">{(data?.jobs || []).map((job) => { const active = ['queued','running','paused'].includes(job.status); const selected = selectedHistoryJobs.includes(String(job.id)); return <article key={job.id} className={`history-row ${selected ? 'selected' : ''}`}><label className="history-select" title={active ? 'Cancel or complete this audit before deleting it' : `Select audit ${job.id}`}><input type="checkbox" disabled={active || !data?.access?.canManage} checked={selected} onChange={(event) => setSelectedHistoryJobs((current) => event.target.checked ? [...new Set([...current, String(job.id)])] : current.filter((id) => id !== String(job.id)))}/></label><button className="history-open" onClick={() => loadJob(job.id)}><span className={`history-state ${job.status}`}>{job.status}</span><span className="history-identity"><b>{auditAgentLabel(job)} · Audit #{job.id}</b><small>{formatDate(job.createdAt)} · Structured result data only</small></span>{job.scoreSummary && <span className="history-scores"><b className="quality">Q {job.scoreSummary.quality}</b><b className="efficiency">E {job.scoreSummary.efficiency}</b><b className="process">P {job.scoreSummary.process}</b><b className="final">Final {job.scoreSummary.final}</b></span>}<span className="history-count"><b>{job.processed}/{job.total}</b><small>{job.evaluations} evaluations</small></span><i className="history-arrow" aria-hidden="true">→</i></button></article>; })}{!data?.jobs?.length && <div className="empty-results"><h3>No audit history yet</h3><p>Your completed and resumable batches will appear here.</p></div>}</div></section></div>}

        {view === 'disputes' && data?.access?.canReviewDisputes && <div className="audit-admin-page"><section className="audit-card"><div className="card-heading"><div><span>Review queue</span><h2>Audit disputes</h2><p>Pending items appear first. Open the original result to review the full verdict, transcript, and highlighted evidence before deciding.</p></div><button onClick={() => bootstrap()}>Refresh</button></div><div className="audit-admin-summary"><div><b>{data.auditDisputes?.filter((item) => item.status === 'pending').length || 0}</b><span>Pending</span></div><div><b>{data.auditDisputes?.filter((item) => item.status === 'approved').length || 0}</b><span>Approved</span></div><div><b>{data.auditDisputes?.filter((item) => item.status === 'rejected').length || 0}</b><span>Rejected</span></div></div><div className="audit-dispute-queue">{[...(data.auditDisputes || [])].sort((a,b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((item) => <article key={item.id}><div><span className={`audit-dispute-status ${item.status}`}>{item.status === 'pending' ? 'Needs decision' : item.status}</span><h3>{item.agentName || 'Unknown agent'} · Conversation {item.conversationId}</h3><small>Submitted by {item.submittedBy || item.submittedByEmail || 'Unknown'} · {formatDate(item.createdAt)}</small><p>{item.reason}</p>{item.status !== 'pending' && <small>Reviewed by {item.reviewedBy || 'Unknown'} · {formatDate(item.reviewedAt)}</small>}</div><button onClick={() => openAuditDispute(item)}>{item.status === 'pending' ? 'Review dispute' : 'Open decision'} →</button></article>)}{!data.auditDisputes?.length && <div className="empty-results"><h3>No audit disputes</h3><p>Submitted disputes will appear here automatically.</p></div>}</div></section></div>}

        {view === 'snippets' && data?.access?.canReviewDisputes && <div className="audit-admin-page"><section className="audit-card"><div className="card-heading"><div><span>Audit-only knowledge</span><h2>Approved audit snippets</h2><p>These instructions improve future audits only. They never enter the support chatbot. Disable guidance temporarily or delete it permanently.</p></div><button onClick={() => bootstrap()}>Refresh</button></div><div className="audit-admin-summary"><div><b>{data.auditSnippets?.filter((item) => item.active !== false).length || 0}</b><span>Active</span></div><div><b>{data.auditSnippets?.filter((item) => item.active === false).length || 0}</b><span>Inactive</span></div><div><b>{data.auditSnippets?.reduce((sum,item) => sum + (item.evidence?.length || 0), 0) || 0}</b><span>Evidence links</span></div></div><div className="audit-snippet-list">{(data.auditSnippets || []).map((snippet) => <AuditSnippetEditor key={`${snippet.id}-${snippet.updatedAt || ''}`} snippet={snippet} busy={savingAdmin === `snippet-${snippet.id}`} onSave={saveAuditSnippet} onDelete={deleteAuditSnippet}/>)}{!data.auditSnippets?.length && <div className="empty-results"><h3>No approved audit snippets</h3><p>Approving a dispute creates audit-only guidance here after a fresh FAQ and Notices check.</p></div>}</div></section></div>}

        {view === 'settings' && data?.access?.canManage && <div className="audit-settings-grid">
          <section className="audit-card"><div className="card-heading"><div><span>Intercom directory</span><h2>Agents and support level <AuditTip text="Enabled agents appear in audit selection. Level 2 agents are measured on AHT only because their work follows an email-style response cadence."/></h2><p>Sync the live directory, choose who can be sampled, and mark Level 2 email support.</p></div><button disabled={syncingAgents} onClick={syncAgents}>{syncingAgents ? 'Syncing…' : '↻ Sync Intercom'}</button></div><div className="admin-agent-search"><span aria-hidden="true">⌕</span><input value={adminAgentSearch} onChange={(event) => setAdminAgentSearch(event.target.value)} placeholder="Search by agent name, email, or Intercom ID…" aria-label="Search Intercom agents"/>{adminAgentSearch && <button type="button" onClick={() => setAdminAgentSearch('')} aria-label="Clear agent search">×</button>}<small>{adminVisibleAgents.length} of {(data.agents || []).length}</small></div><div className="admin-agent-list">{adminVisibleAgents.map((agent) => { const enabled = enabledDraft.includes(agent.id); const level2 = level2Draft.includes(agent.id); return <div key={agent.id} className={`admin-agent-row ${enabled ? 'enabled' : ''}`}><label><input type="checkbox" checked={enabled} onChange={() => { setEnabledDraft((current) => current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id]); if (enabled) setLevel2Draft((current) => current.filter((id) => id !== agent.id)); }}/><span><b>{agent.name}</b><small>{agent.email || agent.id}</small></span><em>{agent.hasInboxSeat ? 'Inbox seat' : 'No inbox seat'}</em></label><span className="level2-control"><button type="button" className={`level2-toggle ${level2 ? 'active' : ''}`} disabled={!enabled} aria-pressed={level2} onClick={() => setLevel2Draft((current) => current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id])}>{level2 ? 'Level 2 · AHT only' : 'Standard · FRT + ART + AHT'}</button><AuditTip text="Level 2 removes FRT and ART from scoring. Each AHT episode runs through the snooze or manual-close event after the reply; a returning client starts a new episode."/></span></div>; })}{!adminVisibleAgents.length && <div className="admin-agent-empty"><b>No matching agents</b><span>Try a name, email address, or Intercom ID.</span></div>}</div><button className="settings-save" disabled={savingAdmin === 'save-agents'} onClick={() => saveAdmin('save-agents', { agentIds: enabledDraft, level2AgentIds: level2Draft }, 'Audit agents and Level 2 rules updated.')}>{savingAdmin === 'save-agents' ? 'Saving…' : `Save ${enabledDraft.length} enabled agents`}</button></section>
          <section className="audit-card"><div className="card-heading"><div><span>Restricted access</span><h2>Authorized auditors</h2><p>One verified @nextventures.io email per line. Faiyaz and Master access remain protected.</p></div></div><textarea rows={8} value={accessDraft} onChange={(event) => setAccessDraft(event.target.value)} placeholder="name@nextventures.io"/><button className="settings-save" disabled={savingAdmin === 'save-access'} onClick={() => saveAdmin('save-access', { emails: accessDraft.split(/[\s,]+/).filter(Boolean) }, 'Conversation Audit access updated.')}>{savingAdmin === 'save-access' ? 'Saving…' : 'Save audit access'}</button></section>
          <section className="audit-card"><div className="card-heading"><div><span>Agent visibility</span><h2>My Audits access</h2><p>These users can see only audit results matched to their own Intercom email, open their transcripts, and submit disputes. They cannot run audits or see developer API keys.</p></div></div><textarea rows={8} value={selfAccessDraft} onChange={(event) => setSelfAccessDraft(event.target.value)} placeholder="agent@nextventures.io"/><button className="settings-save" disabled={savingAdmin === 'save-self-access'} onClick={() => saveAdmin('save-self-access', { emails: selfAccessDraft.split(/[\s,]+/).filter(Boolean) }, 'My Audits access updated.')}>{savingAdmin === 'save-self-access' ? 'Saving…' : 'Save My Audits access'}</button></section>
          <section className="audit-card"><div className="card-heading"><div><span>Failover order</span><h2>Gemini model chain</h2><p>One stable model ID per line. The next model and key are tried automatically.</p></div></div><textarea className="mono" rows={8} value={modelsDraft} onChange={(event) => setModelsDraft(event.target.value)} placeholder="gemini-3.5-flash-lite"/><button className="settings-save" disabled={savingAdmin === 'save-models'} onClick={() => saveAdmin('save-models', { models: modelsDraft.split(/[\s,]+/).filter(Boolean) }, 'Gemini audit model chain updated.')}>{savingAdmin === 'save-models' ? 'Saving…' : 'Save model chain'}</button></section>
          <section className="audit-card developer-api-card"><div className="card-heading"><div><span>Controlled testing access</span><h2>Developer API keys</h2><p>Create a temporary, revocable key for deployed chatbot and auditor testing. Intercom and Gemini secrets remain inside the app.</p></div><span className={`developer-live-state ${developerConnection?.connected ? 'connected' : ''}`}><i/>{developerConnection?.connected ? 'Connected' : 'Scoped access'}</span></div><div className="developer-key-form"><label>Name<input value={developerKeyName} maxLength={80} onChange={(event) => setDeveloperKeyName(event.target.value)} placeholder="Codex testing"/></label><label>Expires<select value={developerKeyDays} onChange={(event) => setDeveloperKeyDays(event.target.value)}><option value="1">24 hours</option><option value="7">7 days</option><option value="30">30 days</option></select></label><button className="settings-save" disabled={savingAdmin === 'create-external-key'} onClick={createDeveloperKey}>{savingAdmin === 'create-external-key' ? 'Creating and testing…' : 'Generate testing key'}</button></div><div className="developer-scopes">{(data.developerScopes || []).map((scope) => <span key={scope}>✓ {scope}</span>)}</div>{revealedDeveloperKey && <div className="developer-key-reveal"><div><span>Copy this key now</span><b>{developerConnection?.connected ? 'Connection verified' : 'Testing connection…'}</b></div><code>{revealedDeveloperKey}</code><button onClick={() => navigator.clipboard.writeText(revealedDeveloperKey)}>Copy key</button><small>{developerConnection?.detail || 'The full key is displayed only once.'}</small></div>}<div className="developer-endpoints"><span>Available endpoints</span><code>POST /api/external/chat-test</code><code>POST /api/external/audit?action=create-job</code><code>GET /api/external/audit?action=job&amp;id=…</code><code>GET /api/external/health</code><code>GET /api/external/diagnostics</code></div><div className="developer-key-list">{(data.developerKeys || []).map((item) => <article key={item.id} className={item.status}><div><b>{item.name}</b><small>{item.prefix}… · expires {formatDate(item.expiresAt)}</small><small>{item.lastUsedAt ? `Last used ${formatDate(item.lastUsedAt)}` : 'Never used'}</small></div><span>{item.status}</span>{item.status === 'active' && <button disabled={savingAdmin === `revoke-${item.id}`} onClick={() => revokeDeveloperKey(item.id)}>Revoke</button>}</article>)}{!(data.developerKeys || []).length && <p className="developer-empty">No developer keys have been generated.</p>}</div></section>
          <section className="audit-card thresholds-card editable"><div className="card-heading"><div><span>Confirmed scoring targets</span><h2>Efficiency thresholds</h2><p>Saved values are snapshotted into every new audit batch. Existing reports keep the targets they were scored against.</p></div></div><ThresholdGroup title="Level 1 / live support" value={thresholdDraft.standard} onChange={(standard) => setThresholdDraft((current) => ({ ...current, standard }))} note="FRT, ART and AHT all apply. AHT is displayed and edited in minutes."/><ThresholdGroup title="Level 2 / email support" value={thresholdDraft.level2} onChange={(level2) => setThresholdDraft((current) => ({ ...current, level2 }))} note="AHT currently drives Level 2 timing. FRT and ART remain configurable here for any future policy change."/><button className="settings-save" disabled={savingAdmin === 'save-thresholds'} onClick={() => saveAdmin('save-thresholds', { thresholds: thresholdDraft }, 'Efficiency thresholds saved. Every new audit will use these values.')}>{savingAdmin === 'save-thresholds' ? 'Saving…' : 'Save efficiency thresholds'}</button></section>
        </div>}
      </main>
    </div>
    <ConversationReviewModal state={comparison} onClose={() => setComparison(null)} onSubmitDispute={submitAuditDispute} onReviewDispute={reviewAuditDispute} onEditScore={editAuditScore} canReview={data?.access?.canReviewDisputes}/>
  </>;
}
