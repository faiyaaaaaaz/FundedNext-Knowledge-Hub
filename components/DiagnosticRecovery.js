import { useEffect, useState } from 'react';

const labels = { queries: 'Query history', disputes: 'Approved disputes', snippets: 'Inactive snippet instructions', events: 'Snippet-use history' };
const date = (value) => new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' });

export default function DiagnosticRecovery({ session }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);
  const [setupRequired, setSetupRequired] = useState(false);
  const [limitMb, setLimitMb] = useState('');
  const [limitMessage, setLimitMessage] = useState('');
  async function refresh() {
    try {
      const response = await fetch('/api/recovery', { headers: { 'x-app-session': session } });
      const data = await response.json();
      if (!response.ok) { setSetupRequired(!!data.setupRequired); throw new Error(data.error || 'Recovery history could not be loaded.'); }
      setSetupRequired(false); setHistory(data.imports || []);
    } catch (failure) { setError(failure.message); }
  }
  useEffect(() => { refresh(); }, [session]);
  async function upload(action) {
    if (!file) return;
    setBusy(action); setError(''); setResult(null);
    try {
      const response = await fetch(`/api/recovery?action=${action}`, { method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-app-session': session, ...(action === 'restore' ? { 'x-recovery-hash': preview.reportHash } : {}) }, body: file });
      const data = await response.json();
      if (!response.ok) { if (data.setupRequired) setSetupRequired(true); throw new Error(data.error || 'Recovery could not complete.'); }
      setSetupRequired(false);
      if (action === 'preview') setPreview(data);
      else { setResult(data); setPreview(null); await refresh(); }
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }
  async function saveLimit() {
    setBusy('limit'); setLimitMessage('');
    try {
      const response = await fetch('/api/database-health', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-session': session }, body: JSON.stringify({ databaseLimitMb: limitMb === '' ? null : Number(limitMb) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save database allowance.');
      setLimitMessage('Saved. Refresh the assistant page to see the live database reading.');
    } catch (failure) { setLimitMessage(failure.message); }
    finally { setBusy(''); }
  }
  const shown = result || preview;
  return <div className="settings-stack">
    <section className="settings-card">
      <div className="settings-head"><div><h2>Restore from a diagnostic report</h2><p>Recover missing query history, approved disputes, snippet instructions, and usage history from a combined .json.gz report.</p></div></div>
      <p className="field-help">Existing records are preserved. Notices are excluded and use their separate upload. Recovered snippets start inactive so historical instructions can be reviewed before affecting new answers.</p>
      {setupRequired && <div className="inline-error">Run the supplied <b>sql/diagnostic-recovery-and-health.sql</b> once in Supabase → SQL Editor. Then refresh this section.</div>}
      <label htmlFor="recovery-file">Combined diagnostics file</label>
      <input id="recovery-file" type="file" accept=".gz,.json" disabled={!!busy} onChange={(event) => { const selected = event.target.files?.[0] || null; setFile(selected); setPreview(null); setResult(null); setError(selected && selected.size > 3.5 * 1024 * 1024 ? 'Use a compressed .json.gz report below 3.5 MB.' : ''); }} />
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn btn-secondary" disabled={!!busy || !file || file.size > 3.5 * 1024 * 1024} onClick={() => upload('preview')}>{busy === 'preview' ? 'Checking missing records…' : 'Check file'}</button>
        <button className="btn btn-primary" disabled={!!busy || !preview || setupRequired} onClick={() => upload('restore')}>{busy === 'restore' ? 'Restoring missing records…' : 'Restore missing records'}</button>
        <button className="btn btn-secondary" disabled={!!busy} onClick={() => { setError(''); refresh(); }}>Refresh</button>
      </div>
      {error && <div className="inline-error" style={{ marginTop: 12 }}>{error}</div>}
      {shown && <div style={{ marginTop: 20 }}>
        <h3>{result ? 'Recovery completed' : 'File checked'}</h3>
        <p>Report exported {date(shown.exportedAt)} (Dhaka time).</p>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', textAlign: 'left' }}><thead><tr><th>Records</th><th>{result ? 'Restored' : 'Missing'}</th><th>Already present</th><th>ID conflicts</th><th>Blocked links</th></tr></thead><tbody>{Object.entries(shown.results || {}).map(([kind, counts]) => <tr key={kind}><td>{labels[kind] || kind}</td><td>{counts.restored}</td><td>{counts.existing}</td><td>{counts.conflicts}</td><td>{counts.blocked}</td></tr>)}</tbody></table></div>
        <p className="field-help">Conflicts and blocked links are skipped. No current record is overwritten. Records may change between this check and restore; the final counts are authoritative.</p>
        <p>{shown.inventory.fullAnswers} full answers · {shown.inventory.answerPreviews} answer previews · {shown.inventory.missingAnswers} records without a stored answer.</p>
        <p>{shown.inventory.fullQuestions} full questions · {shown.inventory.questionPreviews} question previews · {shown.inventory.missingQuestions} records without a stored question.</p>
        <p>{shown.inventory.noticesExcluded} notices excluded · {shown.inventory.ambiguousSnippets} ambiguous snippet candidates held.</p>
        {result && <p className="field-help">Open Query &amp; answer logs, Disputes, Snippets, or Snippet usage logs to view the restored records. Use each snippet’s existing review/activation controls when appropriate.</p>}
      </div>}
    </section>
    <section className="settings-card"><div className="settings-head"><div><h2>Recent recovery uploads</h2><p>Completed imports are recorded here. Uploading the same report again skips records already present.</p></div></div>{history.map(item => <details key={item.report_hash}><summary>{date(item.imported_at)} · {item.imported_by || 'Admin'}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(item.summary, null, 2)}</pre></details>)}{!history.length && <p>No completed recovery uploads.</p>}</section>
    <section className="settings-card"><div className="settings-head"><div><h2>Database storage allowance</h2><p>The health panel reads the actual PostgreSQL database size. Optionally enter your project’s database allowance to display a percentage.</p></div></div><label htmlFor="database-limit">Database allowance in MB (1 MB = 1,000,000 bytes)</label><input id="database-limit" type="number" min="1" step="1" value={limitMb} onChange={event => setLimitMb(event.target.value)} placeholder="Enter your project’s actual allowance" /><p className="field-help">Leave blank to show only the live database size. This reading excludes other project disk usage such as WAL and is separate from file storage.</p><button className="btn btn-secondary" disabled={!!busy} onClick={saveLimit}>{busy === 'limit' ? 'Saving…' : 'Save allowance'}</button>{limitMessage && <p>{limitMessage}</p>}</section>
  </div>;
}
