import { useEffect, useMemo, useRef, useState } from 'react';

const PRODUCT_ORDER = ['cfd', 'futures', 'policy'];
const productName = (product) => product === 'cfd' ? 'CFD' : product === 'futures' ? 'Futures' : 'Non-product policies';

function nodePosition(index, total) {
  const angle = ((index / Math.max(total, 1)) * Math.PI * 2) - Math.PI / 2;
  const radiusX = total < 5 ? 220 : 300;
  const radiusY = total < 5 ? 115 : 145;
  return { x: 400 + Math.cos(angle) * radiusX, y: 265 + Math.sin(angle) * radiusY, z: Math.round(Math.sin(angle) * 120) };
}

function ArticleList({ group, kind }) {
  const [open, setOpen] = useState(false);
  const visible = open ? group.articles : group.articles.slice(0, 6);
  return <section className="brain-article-panel">
    <div><span>{kind === 'faq' ? 'FAQ articles' : 'Notice records'}</span><b>{group.label}</b><small>{group.count} live {kind === 'faq' ? 'articles' : 'records'}</small></div>
    <ol>{visible.map((article) => <li key={article.id}><a href={article.url || undefined} target={article.url ? '_blank' : undefined} rel="noreferrer">{article.title}</a><small>{article.status}{article.updatedAt ? ` · ${new Date(article.updatedAt).toLocaleDateString()}` : ''}</small></li>)}</ol>
    {group.count > 6 && <button type="button" onClick={() => setOpen((value) => !value)}>{open ? 'Collapse article list' : `Expand all ${group.count} articles`}</button>}
  </section>;
}

function Constellation({ groups, kind, selectedId, onSelect, collapsed }) {
  const visible = collapsed ? [] : groups;
  return <div className={`brain-constellation ${kind}`}>
    <div className="brain-root"><span>{kind === 'faq' ? 'FAQ' : 'Notices'}</span><b>{groups.reduce((sum, group) => sum + group.count, 0)}</b></div>
    {visible.map((group, index) => {
      const position = nodePosition(index, visible.length);
      const selected = selectedId === `${kind}:${group.id}`;
      return <button key={group.id} type="button" className={`brain-node ${group.product}${selected ? ' selected' : ''}`} style={{ '--x': `${position.x}px`, '--y': `${position.y}px`, '--z': `${position.z}px` }} onClick={() => onSelect(selected ? null : `${kind}:${group.id}`)}>
        <span>{productName(group.product)}</span><b>{group.label}</b><em>{group.count}</em>
      </button>;
    })}
  </div>;
}

export default function KnowledgeMap({ session }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [rotation, setRotation] = useState({ x: 59, y: -18 });
  const [zoom, setZoom] = useState(1);
  const [collapsed, setCollapsed] = useState({ faq: false, notices: false });
  const drag = useRef(null);
  // Admin APIs authenticate with the same session header used throughout the
  // Admin console.  Using a Bearer header here made the map look logged out
  // even while the rest of the console had a valid session.
  const headers = useMemo(() => ({ 'x-app-session': session }), [session]);
  const load = async () => {
    setError('');
    try {
      const response = await fetch('/api/knowledge-map', { headers });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load the knowledge map.');
      setData(payload);
    } catch (loadError) { setError(loadError.message); }
  };
  useEffect(() => {
    load();
    const refresh = setInterval(load, 60000);
    return () => clearInterval(refresh);
  }, [session]);
  const selectedGroup = selected && data ? (() => {
    const [kind, ...id] = selected.split(':');
    return { kind, group: (data[kind] || []).find((item) => item.id === id.join(':')) };
  })() : null;
  const onPointerDown = (event) => { drag.current = { x: event.clientX, y: event.clientY, rotation }; event.currentTarget.setPointerCapture?.(event.pointerId); };
  const onPointerMove = (event) => {
    if (!drag.current) return;
    const dx = event.clientX - drag.current.x, dy = event.clientY - drag.current.y;
    setRotation({ x: Math.max(24, Math.min(78, drag.current.rotation.x - dy * .18)), y: drag.current.rotation.y + dx * .25 });
  };
  const onPointerUp = () => { drag.current = null; };
  const onWheel = (event) => { event.preventDefault(); setZoom((value) => Math.max(.65, Math.min(1.45, value - event.deltaY * .0008))); };
  if (!data && !error) return <section className="brain-loading"><span className="loader-mark" /><div><b>Mapping live knowledge</b><small>Organising FAQ and Notice records by product and Account scope…</small></div></section>;
  if (error) return <section className="brain-loading"><div><b>Knowledge map unavailable</b><small>{error}</small><button className="btn btn-secondary" onClick={load}>Try again</button></div></section>;
  return <section className="brain-map-shell">
    <header className="brain-map-head"><div><span className="eyebrow">Live knowledge topology</span><h2>Knowledge brain</h2><p>{data.totals.faq.toLocaleString()} FAQ articles and {data.totals.notices.toLocaleString()} Notices, arranged by product, Account scope, and policy.</p></div><div className="brain-actions"><button className="btn btn-secondary" onClick={load}>Refresh live data</button><button className="btn btn-secondary" onClick={() => setRotation({ x: 59, y: -18 })}>Reset view</button><button className="btn btn-secondary" onClick={() => setCollapsed((value) => ({ faq: !value.faq, notices: !value.notices }))}>{collapsed.faq && collapsed.notices ? 'Expand maps' : 'Collapse maps'}</button></div></header>
    <div className="brain-hint">Drag to rotate · scroll to zoom · select a node to inspect its live article list</div>
    <div className="brain-viewport" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel}>
      <div className="brain-world" style={{ transform: `scale(${zoom}) rotateX(${rotation.x}deg) rotateZ(${rotation.y}deg)` }}>
        <Constellation groups={data.faq} kind="faq" selectedId={selected} onSelect={setSelected} collapsed={collapsed.faq} />
        <Constellation groups={data.notices} kind="notices" selectedId={selected} onSelect={setSelected} collapsed={collapsed.notices} />
      </div>
    </div>
    <div className="brain-legend">{PRODUCT_ORDER.map((product) => <span key={product} className={product}><i />{productName(product)}</span>)}<small>Updated {new Date(data.generatedAt).toLocaleString()}</small></div>
    {selectedGroup?.group && <ArticleList group={selectedGroup.group} kind={selectedGroup.kind} />}
  </section>;
}
