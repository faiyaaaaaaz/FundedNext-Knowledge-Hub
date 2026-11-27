import { useState } from 'react';

// Admin tool: upload a reviewed image-readings file. The readings are saved and
// every listed article is indexed from them, with no AI vision calls. Sign in to
// the app first (same browser), then open /knowledge-import.
export default function KnowledgeImport() {
  const [state, setState] = useState({ busy: false, lines: [], summary: null, error: '' });

  const log = (line) => setState((current) => ({ ...current, lines: [...current.lines.slice(-12), line] }));

  async function run(file) {
    if (!file) return;
    setState({ busy: true, lines: ['Reading the file…'], summary: null, error: '' });
    try {
      const session = localStorage.getItem('appSession') || '';
      if (!session) throw new Error('Sign in to the app in this browser first, then reload this page.');
      const parsed = JSON.parse(await file.text());
      if (parsed.format !== 'fundednext-image-readings-v1' || !Array.isArray(parsed.articles)) throw new Error('This is not a FundedNext image-readings file.');
      const headers = { 'Content-Type': 'application/json', 'x-app-session': session };
      let payload = { format: parsed.format, articles: parsed.articles };
      let indexed = 0, partial = 0, other = 0, rounds = 0, saved = 0;
      const problems = [];
      for (;;) {
        rounds++;
        const response = await fetch('/api/knowledge-import', { method: 'POST', headers, body: JSON.stringify(payload) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `The import stopped (HTTP ${response.status}).`);
        saved += data.stored || 0;
        for (const item of data.results || []) {
          if (item.status === 'indexed') indexed++;
          else if (item.status === 'partial') { partial++; problems.push(`Article ${item.id}: images ${item.missingImages?.join(', ') || '?'} had no reading`); }
          else { other++; problems.push(`Article ${item.id}: ${item.status}`); }
        }
        log(`Round ${rounds}: ${indexed} articles published, ${data.remaining?.length ?? 0} still to do…`);
        if (data.done) break;
        if (!data.processed) { await new Promise((resolve) => setTimeout(resolve, 8000)); }
        if (rounds > 200) throw new Error('Stopped after 200 rounds. Run the import again to continue.');
        payload = { articleIds: data.remaining };
      }
      setState((current) => ({ ...current, busy: false, summary: { indexed, partial, other, saved, problems } }));
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: String(error.message || error) }));
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: '48px auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}>
      <h1 style={{ fontSize: 24 }}>Import FAQ image readings</h1>
      <p>Upload the reviewed <code>.json</code> file. Each article is published with its image text. No AI vision credits are used. Keep this tab open until it says Finished (a few minutes).</p>
      <input type="file" accept="application/json,.json" disabled={state.busy} onChange={(event) => run(event.target.files?.[0])} />
      {state.lines.length > 0 && <pre style={{ background: 'rgba(127,127,127,.12)', padding: 12, borderRadius: 8, whiteSpace: 'pre-wrap' }}>{state.lines.join('\n')}</pre>}
      {state.error && <p style={{ color: '#b00020', fontWeight: 600 }}>{state.error}</p>}
      {state.summary && (
        <div>
          <h2 style={{ fontSize: 18 }}>Finished</h2>
          <p>{state.summary.indexed} articles published, {state.summary.partial} partly covered, {state.summary.other} skipped. {state.summary.saved} image readings saved.</p>
          {state.summary.problems.length > 0 && <pre style={{ whiteSpace: 'pre-wrap' }}>{state.summary.problems.slice(0, 40).join('\n')}</pre>}
        </div>
      )}
    </main>
  );
}
