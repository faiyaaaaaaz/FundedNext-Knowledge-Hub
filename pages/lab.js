// ============================================================================
// pages/lab.js  — hidden experimental surface (upload notices + test the bot)
// Self-contained. Reuses the app's existing login token from localStorage
// ('appSession', sent as the 'x-app-session' header). Access is enforced
// server-side by the allowlist in /api/notices and /api/search-next.
// ============================================================================
import { useState, useEffect } from 'react';
import Head from 'next/head';

export default function Lab() {
  const [session, setSession] = useState('');
  const [email, setEmail] = useState('');
  const [ready, setReady] = useState(false);

  // upload state
  const [fileName, setFileName] = useState('');
  const [ragText, setRagText] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [importErr, setImportErr] = useState('');

  // chat state
  const [product, setProduct] = useState('cfd');
  const [model, setModel] = useState('all');
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState(null);
  const [chatErr, setChatErr] = useState('');

  useEffect(() => {
    try {
      setSession(localStorage.getItem('appSession') || '');
      setEmail(localStorage.getItem('appEmail') || '');
    } catch (e) {}
    setReady(true);
  }, []);

  const hdr = (json) => ({ ...(json ? { 'Content-Type': 'application/json' } : {}), 'x-app-session': session });

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name); setImportMsg(''); setImportErr('');
    const text = await f.text();
    try { JSON.parse(text); setRagText(text); }
    catch (err) { setImportErr('That file is not valid JSON.'); setRagText(''); }
  }

  async function doImport() {
    if (!ragText) { setImportErr('Choose the combined RAG .json file first.'); return; }
    setImportBusy(true); setImportMsg(''); setImportErr('');
    try {
      const r = await fetch('/api/notices', { method: 'POST', headers: hdr(true), body: JSON.stringify({ action: 'import', rag: ragText }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Import failed.');
      setImportMsg(`Imported ${d.imported} entries · reconciled ${d.reconciled} · indexed ${d.indexed} into the bot.`);
    } catch (err) { setImportErr(err.message); } finally { setImportBusy(false); }
  }

  async function doReindex() {
    setImportBusy(true); setImportMsg(''); setImportErr('');
    try {
      const r = await fetch('/api/notices', { method: 'POST', headers: hdr(true), body: JSON.stringify({ action: 'reindex' }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Reindex failed.');
      setImportMsg(`Re-indexed ${d.indexed} active notices.`);
    } catch (err) { setImportErr(err.message); } finally { setImportBusy(false); }
  }

  async function ask() {
    const q = question.trim();
    if (!q) return;
    setAsking(true); setChatErr(''); setResult(null);
    try {
      const r = await fetch('/api/search-next', { method: 'POST', headers: hdr(true), body: JSON.stringify({ question: q, scope: { product, model } }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Request failed.');
      setResult(d);
    } catch (err) { setChatErr(err.message); } finally { setAsking(false); }
  }

  const box = { background: '#14141c', border: '1px solid #2a2a3a', borderRadius: 12, padding: 20, marginBottom: 18 };
  const btn = { background: '#6d4aff', color: '#fff', border: 0, borderRadius: 8, padding: '10px 16px', cursor: 'pointer', fontWeight: 600 };
  const btn2 = { ...btn, background: '#2a2a3a' };

  if (!ready) return null;

  return (
    <div style={{ minHeight: '100vh', background: '#0c0c12', color: '#e8e8f0', fontFamily: 'system-ui, sans-serif' }}>
      <Head><title>Notices Lab</title></Head>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '32px 20px' }}>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>🧪 Notices Lab <span style={{ fontSize: 13, color: '#8a8aa0' }}>(experimental — only you can see this)</span></h1>
        <p style={{ color: '#8a8aa0', fontSize: 13, marginBottom: 24 }}>
          Signed in as {email || '(unknown — open the main app and sign in first)'} · <a href="/" style={{ color: '#9d86ff' }}>← Back to assistant</a>
        </p>

        {!session && (
          <div style={{ ...box, borderColor: '#a33' }}>
            No login found in this browser. Open the main app, sign in with Google, then come back to <b>/lab</b>.
          </div>
        )}

        {/* UPLOAD */}
        <div style={box}>
          <h2 style={{ fontSize: 16, marginBottom: 6 }}>1 · Upload the notices file</h2>
          <p style={{ color: '#8a8aa0', fontSize: 13, marginBottom: 14 }}>Choose <code>notices_rag.combined.json</code>. This imports, resolves supersession, and loads it into the Lab bot.</p>
          <input type="file" accept="application/json,.json" onChange={onFile} style={{ marginBottom: 12, display: 'block' }} />
          {fileName && <div style={{ fontSize: 12, color: '#8a8aa0', marginBottom: 12 }}>Selected: {fileName}</div>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={btn} disabled={importBusy || !ragText} onClick={doImport}>{importBusy ? 'Working…' : 'Upload & load'}</button>
            <button style={btn2} disabled={importBusy} onClick={doReindex}>Re-index only</button>
          </div>
          {importMsg && <div style={{ marginTop: 12, color: '#5fd08a', fontSize: 14 }}>✓ {importMsg}</div>}
          {importErr && <div style={{ marginTop: 12, color: '#ff7a7a', fontSize: 14 }}>{importErr}</div>}
        </div>

        {/* CHAT */}
        <div style={box}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>2 · Test the bot (notices + FAQ)</h2>
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <select value={product} onChange={(e) => setProduct(e.target.value)} style={{ background: '#0c0c12', color: '#e8e8f0', border: '1px solid #2a2a3a', borderRadius: 8, padding: '8px 10px' }}>
              <option value="cfd">CFD</option><option value="futures">Futures</option><option value="both">Both</option>
            </select>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model slug or 'all'"
              style={{ background: '#0c0c12', color: '#e8e8f0', border: '1px solid #2a2a3a', borderRadius: 8, padding: '8px 10px', flex: 1 }} />
          </div>
          <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} placeholder="Ask something the notices changed, e.g. 'What is the crypto payout limit?'"
            style={{ width: '100%', background: '#0c0c12', color: '#e8e8f0', border: '1px solid #2a2a3a', borderRadius: 8, padding: 12, marginBottom: 12, boxSizing: 'border-box' }} />
          <button style={btn} disabled={asking || !session} onClick={ask}>{asking ? 'Thinking…' : 'Ask'}</button>
          {chatErr && <div style={{ marginTop: 12, color: '#ff7a7a', fontSize: 14 }}>{chatErr}</div>}

          {result && (
            <div style={{ marginTop: 18 }}>
              {result.escalations?.length > 0 && (
                <div style={{ background: '#3a2412', border: '1px solid #a9711f', borderRadius: 10, padding: 14, marginBottom: 14 }}>
                  <div style={{ fontWeight: 700, color: '#ffcf8a', marginBottom: 6 }}>⚠ Escalation needed (not part of the copiable reply)</div>
                  {result.escalations.map((x, i) => (
                    <div key={i} style={{ fontSize: 13, marginBottom: 8 }}>
                      <div><b>Where:</b> {x.target}{x.channel ? ` · ${x.channel}` : ''}</div>
                      {x.condition && <div><b>When:</b> {x.condition}</div>}
                      {x.reason && <div style={{ color: '#c9b48f' }}>{x.reason}</div>}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ background: '#0c0c12', border: '1px solid #2a2a3a', borderRadius: 10, padding: 14, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{result.answer}</div>
              {result.sources?.length > 0 && (
                <div style={{ marginTop: 12, fontSize: 12, color: '#8a8aa0' }}>
                  <b>Sources</b> ({result.answerProvider}):
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {result.sources.map((s, i) => (
                      <li key={i} style={{ marginBottom: 3 }}>
                        [{s.kind}] {s.url ? <a href={s.url} target="_blank" rel="noreferrer" style={{ color: '#9d86ff' }}>{s.title}</a> : s.title}
                        {s.posted_by ? ` — ${s.posted_by}` : ''}{s.posted_at ? ` (${String(s.posted_at).slice(0, 10)})` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
