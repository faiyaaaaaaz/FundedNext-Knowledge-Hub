import { useCallback, useEffect, useMemo, useState } from 'react';

const PRODUCTS = [
  { id: 'cfd', label: 'CFD', description: 'CFD Accounts and policies' },
  { id: 'futures', label: 'Futures', description: 'Futures Accounts and policies' },
  { id: 'policy', label: 'Policies & rules', description: 'Non-product policies' }
];

function displayScope(group) {
  if (group.model !== 'general') return group.label;
  return group.product === 'policy' ? 'Policies & rules' : `General ${group.product.toUpperCase()} policies`;
}

function ArticleRows({ group }) {
  const [showAll, setShowAll] = useState(false);
  const articles = showAll ? group.articles : group.articles.slice(0, 18);
  return <div className="knowledge-article-list" aria-label={`${group.label} articles`}>
    {articles.length ? articles.map((article) => <a key={article.id} href={article.url || undefined} target={article.url ? '_blank' : undefined} rel="noreferrer" className="knowledge-article-row">
      <span>{article.title}</span><small>{article.updatedAt ? `Updated ${new Date(article.updatedAt).toLocaleDateString()}` : article.status}</small><b aria-hidden="true">↗</b>
    </a>) : <p className="knowledge-empty-scope">No published records are currently assigned to this scope.</p>}
    {group.count > 18 && <button type="button" className="knowledge-show-more" onClick={() => setShowAll((value) => !value)}>{showAll ? 'Show fewer articles' : `Show all ${group.count} articles`}</button>}
  </div>;
}

function ScopeBranch({ group, expanded, onToggle }) {
  const scopeId = `scope-${group.id.replace(/[^a-z0-9]+/gi, '-')}`;
  return <article className={`knowledge-scope ${expanded ? 'expanded' : ''}`}>
    <button type="button" className="knowledge-scope-toggle" onClick={onToggle} aria-expanded={expanded} aria-controls={scopeId}>
      <span className="knowledge-scope-mark" aria-hidden="true" /><span className="knowledge-scope-name">{displayScope(group)}</span><strong>{group.count}</strong><i aria-hidden="true">⌄</i>
    </button>
    {expanded && <div id={scopeId}><ArticleRows group={group} /></div>}
  </article>;
}

function ProductBranch({ product, groups, openScope, onToggleScope }) {
  const sorted = [...groups].sort((a, b) => {
    if (a.model === 'general') return -1;
    if (b.model === 'general') return 1;
    return a.label.localeCompare(b.label);
  });
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return <section className={`knowledge-product ${product.id}`}>
    <header><span className="knowledge-product-icon" aria-hidden="true">{product.id === 'cfd' ? '◫' : product.id === 'futures' ? '↗' : '◇'}</span><div><h3>{product.label}</h3><p>{product.description}</p></div><b>{total}</b></header>
    <div className="knowledge-branch-line" aria-hidden="true" />
    <div className="knowledge-scopes">
      {sorted.map((group) => <ScopeBranch key={group.id} group={group} expanded={openScope === group.id} onToggle={() => onToggleScope(openScope === group.id ? null : group.id)} />)}
    </div>
  </section>;
}

function Explorer({ data, kind }) {
  const [openScope, setOpenScope] = useState(null);
  const groups = data[kind] || [];
  const total = data.totals[kind] || 0;
  return <div className="knowledge-explorer" aria-live="polite">
    <div className="knowledge-explorer-summary"><div><span>{kind === 'faq' ? 'Live FAQ structure' : 'Live Notices structure'}</span><h2>{kind === 'faq' ? 'FAQ explorer' : 'Notices explorer'}</h2><p>Browse by product, then Account scope. Select a scope to reveal its live records.</p></div><b>{total.toLocaleString()}<small>{kind === 'faq' ? 'published FAQs' : 'notice records'}</small></b></div>
    <div className="knowledge-product-grid">
      {PRODUCTS.map((product) => <ProductBranch key={product.id} product={product} groups={groups.filter((group) => group.product === product.id)} openScope={openScope} onToggleScope={setOpenScope} />)}
    </div>
  </div>;
}

export default function KnowledgeMap({ session, kind = 'faq' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const headers = useMemo(() => ({ 'x-app-session': session }), [session]);
  const load = useCallback(async () => {
    setError('');
    try {
      const response = await fetch('/api/knowledge-map', { headers });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load the knowledge explorer.');
      setData(payload);
    } catch (loadError) { setError(loadError.message); }
  }, [headers]);
  useEffect(() => {
    load();
    const refresh = setInterval(load, 60000);
    return () => clearInterval(refresh);
  }, [load]);
  if (!data && !error) return <section className="brain-loading"><span className="loader-mark" /><div><b>Organising live knowledge</b><small>Building the product and Account-scope explorer…</small></div></section>;
  if (error) return <section className="brain-loading"><div><b>Knowledge explorer unavailable</b><small>{error}</small><button className="btn btn-secondary" onClick={load}>Try again</button></div></section>;
  return <section className="knowledge-map-shell">
    <header className="knowledge-map-head"><div><span className="eyebrow">Live {kind === 'faq' ? 'FAQ' : 'Notice'} explorer</span><h1>{kind === 'faq' ? 'FAQ explorer' : 'Notices explorer'}</h1><p>Product and Account-scope hierarchy, updated directly from the live knowledge source.</p></div><div className="knowledge-refresh"><small>Last refreshed {new Date(data.generatedAt).toLocaleString()}</small><button className="btn btn-secondary" onClick={load}>Refresh live data</button></div></header>
    <Explorer data={data} kind={kind} />
  </section>;
}
