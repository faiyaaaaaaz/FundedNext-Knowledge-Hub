import { useEffect, useId, useState } from 'react';
import {
  anchorLabel,
  efficiencyShort,
  formatDhaka,
  formatDhakaDate,
  metricStatusInfo,
  outcomeInfo,
  percentOf,
  safeUrl,
  secondsText,
  sourceKindLabel,
  speakerLabel,
  targetText,
  trackLabel,
  valueText,
} from './scorecardFormat.mjs';

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------
function Chip({ tone = 'none', strong = false, title, children }) {
  return (
    <span className={`scm-chip scm-tone-${tone}${strong ? ' scm-strong' : ''}`} title={title}>
      {children}
    </span>
  );
}

export function ScorecardRing({ percent, tone = 'good', size = '' }) {
  return (
    <div className={`score-ring scm-ring scm-tone-${tone} ${size}`} style={{ '--score': `${percent}%` }} role="img" aria-label={`Score ${percent} percent`}>
      <span>
        <b>{percent}</b>
        <small>%</small>
      </span>
    </div>
  );
}

// Accessible disclosure row. The Edit button (if any) sits beside the toggle, never inside it.
function Row({ id, level = 1, open, onToggle, name, meta, chip, edit, children }) {
  const panel = `${id}-panel`;
  return (
    <div className={`scm-row scm-level-${level}${open ? ' scm-open' : ''}`}>
      <div className="scm-row-head">
        <button type="button" className="scm-toggle" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
          <span className="scm-chev" aria-hidden="true" />
          <span className="scm-name">{name}</span>
          {meta ? <span className="scm-meta">{meta}</span> : null}
          {chip}
        </button>
        {edit}
      </div>
      <div id={panel} className={`scm-collapse${open ? ' is-open' : ''}`}>
        <div className="scm-collapse-inner">
          <div className="scm-body">{children}</div>
        </div>
      </div>
    </div>
  );
}

function StaticRow({ level = 2, name, meta, chip, note }) {
  return (
    <div className={`scm-row scm-level-${level} scm-static`}>
      <div className="scm-row-head">
        <div className="scm-toggle scm-plain">
          <span className="scm-chev scm-chev-none" aria-hidden="true" />
          <span className="scm-name">{name}</span>
          {meta ? <span className="scm-meta">{meta}</span> : null}
          {chip}
        </div>
      </div>
      {note ? <p className="scm-static-note">{note}</p> : null}
    </div>
  );
}

function EditForm({ name, failed, onCancel, onSave }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const next = failed ? 'met' : 'failed';
  const valid = reason.trim().length >= 10;
  const groupId = useId();
  return (
    <form
      className="metric-edit-form scm-edit-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid || busy) return;
        setBusy(true);
        setError('');
        try {
          await onSave(next === 'failed', reason.trim());
        } catch (err) {
          setError(err?.message || 'Could not save this change.');
          setBusy(false);
        }
      }}
    >
      <fieldset className="scm-fieldset">
        <legend>New verdict for {name}</legend>
        <label className="scm-radio">
          <input type="radio" name={`${groupId}-verdict`} checked readOnly />
          <span>{next === 'failed' ? 'Mark as failed' : 'Mark as met'}</span>
        </label>
        <small>Only the opposite of the current verdict can be chosen. The score is recalculated and the original verdict stays on record.</small>
      </fieldset>
      <label>
        Reason for this change (at least 10 characters)
        <textarea required minLength={10} maxLength={800} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain the evidence and why the verdict should change." />
      </label>
      {error ? (
        <p className="metric-edit-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="metric-edit-actions">
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !valid}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function JumpButton({ target, label, onJump, canJump }) {
  if (!onJump) return null;
  if (canJump && !canJump(target)) return null;
  return (
    <button type="button" className="deduction-evidence-link scm-jump" onClick={() => onJump(target)}>
      {label || 'View evidence in conversation'}
      <i aria-hidden="true">↓</i>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Findings (AI comment, sources, evidence)
// ---------------------------------------------------------------------------
function Sources({ sources }) {
  if (!sources?.length) return null;
  return (
    <div className="scm-sources" aria-label="Policy sources">
      <span className="scm-label">{sources.length === 1 ? 'Policy source' : 'Policy sources'}</span>
      <ul>
        {sources.map((source, index) => {
          const href = safeUrl(source.url);
          const kind = sourceKindLabel(source.kind);
          const posted = /notice/i.test(String(source.kind || '')) ? formatDhakaDate(source.postedAt) : '';
          return (
            <li key={`${source.number ?? index}-${index}`}>
              <Chip tone="none">{kind}</Chip>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {source.title || kind}
                  <i aria-hidden="true"> ↗</i>
                  <span className="scm-sr"> (opens in a new tab)</span>
                </a>
              ) : (
                <span className="scm-source-title">{source.title || kind}</span>
              )}
              {posted ? <small>Posted {posted}</small> : null}
              {!href ? <small>No link was saved for this source</small> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Evidence({ items, onJump, canJump }) {
  if (!items?.length) return null;
  return (
    <div className="scm-evidence">
      <span className="scm-label">Evidence</span>
      <ul>
        {items.map((item, index) => {
          const target = { type: 'evidence', evidence: item };
          const when = formatDhaka(item.at);
          const quoted = item.verified && !item.absence && item.quote;
          return (
            <li key={`${item.ref ?? index}-${index}`}>
              {quoted ? (
                <blockquote className="scm-quote">&ldquo;{item.quote}&rdquo;</blockquote>
              ) : item.absence ? (
                <p className="scm-absence">Missing at this point in the conversation. The reply did not include what the scorecard requires.</p>
              ) : (
                <p className="scm-unverified">
                  <b>Quote not verified.</b> The AI cited this message but its exact words were not confirmed{item.quote ? `: ${item.quote}` : '.'}
                </p>
              )}
              <div className="scm-evidence-meta">
                <span>{speakerLabel(item.speaker)}</span>
                {when ? <time>{when}</time> : null}
                <JumpButton target={target} onJump={onJump} canJump={canJump} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Finding({ finding, onJump, canJump }) {
  return (
    <div className="scm-finding">
      <div className="scm-block">
        <h5>What went wrong</h5>
        <p>{finding.what}</p>
      </div>
      {finding.why ? (
        <div className="scm-block">
          <h5>Why this matters</h5>
          <p>{finding.why}</p>
        </div>
      ) : null}
      {finding.recommendation ? (
        <div className="scm-block">
          <h5>Recommendation</h5>
          <p>{finding.recommendation}</p>
        </div>
      ) : null}
      <Sources sources={finding.sources} />
      {finding.clientContext ? (
        <div className="scm-block">
          <h5>Client context</h5>
          <p>{finding.clientContext}</p>
        </div>
      ) : null}
      <Evidence items={finding.evidence} onJump={onJump} canJump={canJump} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Efficiency Metrics
// ---------------------------------------------------------------------------
function EfficiencyMetric({ metric, onJump, canJump }) {
  const status = metricStatusInfo(metric.status);
  const target = targetText(metric);
  const anchors = Array.isArray(metric.anchors) ? metric.anchors : [];
  const reasons = Array.isArray(metric.reasons) ? metric.reasons : [];
  const faults = (Array.isArray(metric.faults) ? metric.faults : []).filter((fault) => !reasons.includes(fault.label));
  const hasValue = metric.value !== null && metric.value !== undefined;
  return (
    <section className="scm-metric">
      <header>
        <b>
          {efficiencyShort(metric.key)}
          <span> {metric.label}</span>
        </b>
        <Chip tone={status.tone}>{status.label}</Chip>
      </header>
      <p className="scm-measure">
        <span>
          <small>Measured</small>
          <b>{valueText(metric)}</b>
        </span>
        {target ? (
          <span>
            <small>Target</small>
            <b>{target}</b>
          </span>
        ) : null}
      </p>
      {metric.detail ? <p className="scm-detail">{metric.status === 'unavailable' && !hasValue ? <b>Why: </b> : null}{metric.detail}</p> : null}
      {reasons.length || faults.length ? (
        <ul className="scm-reasons">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
          {faults.map((fault, index) => (
            <li key={`${fault.type}-${index}`}>
              {fault.label}
              {fault.at ? <small> · {formatDhaka(fault.at)}</small> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {anchors.length ? (
        <div className="scm-jumps">
          {anchors.map((anchor, index) => (
            <JumpButton key={`${anchor.id || anchor.eventId}-${index}`} target={{ type: 'anchor', anchor }} label={anchorLabel(anchor, anchors.length > 1)} onJump={onJump} canJump={canJump} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main verdict
// ---------------------------------------------------------------------------
// props:
//   result      saved result row (needs result.scorecard)
//   canReview   show the yellow Edit buttons
//   onEdit      (key, failed, reason) => Promise, throws on failure
//   onJump      ({type:'evidence', evidence} | {type:'anchor', anchor}) => void  (scrolls to and highlights the message)
//   canJump     same argument => boolean (hides the button when no message can be matched)
export default function ScorecardVerdict({ result, canReview = false, onEdit, onJump, canJump }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const sc = result?.scorecard;
  const [open, setOpen] = useState({});
  const [editKey, setEditKey] = useState(null);
  const editCount = sc?.edits?.length || 0;
  useEffect(() => {
    setOpen({});
    setEditKey(null);
  }, [result?.id]);
  useEffect(() => {
    setEditKey(null);
  }, [editCount]);
  if (!sc) return null;

  const toggle = (id) => setOpen((current) => ({ ...current, [id]: !current[id] }));
  const outcome = outcomeInfo(sc);
  const percent = percentOf(sc);
  const edits = Array.isArray(sc.edits) ? sc.edits : [];
  const lastEdit = (key) => [...edits].reverse().find((entry) => entry.key === key);
  const criticalItems = sc.critical?.items || [];
  const criticalFailed = criticalItems.filter((item) => item.failed).length;
  const clusters = sc.clusters || [];
  const efficiencyCluster = clusters.find((cluster) => cluster.key === 'efficiency');
  const efficiency = sc.efficiency;
  const summary = sc.summary || {};
  const reasons = sc.manualReviewReasons || [];
  const unverified = sc.unverifiedFindings || [];
  const manualChecks = sc.manualChecks || [];
  const rid = (key) => `scm-${uid}-${key}`;
  const editable = canReview && typeof onEdit === 'function';

  const editButton = (key, name, rowId) =>
    editable ? (
      <button
        type="button"
        className="metric-edit-button scm-edit"
        aria-expanded={editKey === key}
        aria-label={`Edit ${name} verdict`}
        onClick={() => {
          setEditKey(editKey === key ? null : key);
          setOpen((current) => ({ ...current, [rowId]: true }));
        }}
      >
        Edit
      </button>
    ) : null;

  const editPanel = (key, name, failed) =>
    editable && editKey === key ? <EditForm name={name} failed={failed} onCancel={() => setEditKey(null)} onSave={(nextFailed, reason) => onEdit(key, nextFailed, reason)} /> : null;

  const auditorNote = (key) => {
    const entry = lastEdit(key);
    if (!entry) return null;
    return (
      <p className="scm-auditor-note">
        <b>Auditor change:</b> {entry.from === 'failed' ? 'Failed' : 'Met'} to {entry.to === 'failed' ? 'failed' : 'met'}
        {entry.by ? ` by ${entry.by}` : ''}. {entry.reason}
      </p>
    );
  };

  const causeRow = (cause, parentId) => {
    const id = rid(`${parentId}-${cause.key}`);
    if (cause.marked && (cause.findings || []).length) {
      return (
        <Row key={cause.key} id={id} level={3} open={!!open[id]} onToggle={() => toggle(id)} name={cause.label} chip={<Chip tone="risk">Marked</Chip>}>
          {cause.findings.map((finding, index) => (
            <Finding key={index} finding={finding} onJump={onJump} canJump={canJump} />
          ))}
        </Row>
      );
    }
    if (cause.verify === 'manual' && !cause.marked)
      return <StaticRow key={cause.key} level={3} name={cause.label} chip={<Chip tone="watch" title="Needs internal records that a transcript cannot show">Not assessed</Chip>} />;
    return <StaticRow key={cause.key} level={3} name={cause.label} chip={<Chip tone={cause.marked ? 'risk' : 'good'}>{cause.marked ? 'Marked' : 'Clear'}</Chip>} />;
  };

  return (
    <div className="scm-root" data-outcome={outcome.key}>
      <section className="scm-hero">
        <ScorecardRing percent={percent} tone={outcome.tone} size="scm-ring-lg" />
        <div className="scm-hero-copy">
          <div className="scm-chips">
            <Chip tone={outcome.tone} strong={outcome.strong}>
              {outcome.label}
            </Chip>
            <Chip tone="none">{trackLabel(sc)}</Chip>
            {sc.manualReview ? <Chip tone="watch">Manual review</Chip> : null}
          </div>
          <h3 className="scm-points">
            {sc.totalPoints ?? 0} <span>/ {sc.maxPoints ?? 100} points</span>
          </h3>
          <small>
            {sc.critical?.failed ? 'A Critical check failed, so the score is 0%.' : `Pass mark ${Math.round((sc.passMark ?? 0.9) * 100)}%`}
            {sc.ticket?.id ? ` · Ticket ${sc.ticket.id}${sc.ticket.state ? ` (${sc.ticket.state})` : ''}` : ''}
          </small>
        </div>
      </section>

      {summary.headline ? (
        <section className="scm-summary">
          <span className="scm-label">AI verdict</span>
          <p>{summary.headline}</p>
        </section>
      ) : null}

      {sc.manualReview ? (
        <section className="scm-notice" role="note">
          <b>Needs a human look</b>
          {reasons.length ? (
            <ul>
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {(summary.strengths || []).length ? (
        <section className="scm-list-block">
          <span className="scm-label">Strengths</span>
          <ul>
            {summary.strengths.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="scm-metrics" role="list" aria-label="Scorecard metrics">
        {criticalItems.length ? (
          <div role="listitem">
            <Row
              id={rid('critical')}
              level={1}
              open={!!open[rid('critical')]}
              onToggle={() => toggle(rid('critical'))}
              name="Critical checks"
              meta={criticalFailed ? `${criticalFailed} of ${criticalItems.length} failed` : `None of ${criticalItems.length} failed`}
              chip={<Chip tone={criticalFailed ? 'risk' : 'good'}>{criticalFailed ? 'Failed' : 'Met'}</Chip>}
            >
              {criticalItems.map((item) => {
                const id = rid(`c-${item.key}`);
                const marked = (item.rootCauses || []).filter((cause) => cause.marked).length;
                return (
                  <Row
                    key={item.key}
                    id={id}
                    level={2}
                    open={!!open[id]}
                    onToggle={() => toggle(id)}
                    name={item.name}
                    meta={item.failed ? 'Failed' : 'Met'}
                    chip={<Chip tone={item.failed ? 'risk' : 'good'}>{marked ? `${marked} marked` : item.failed ? 'Edited' : 'None marked'}</Chip>}
                    edit={editButton(item.key, item.name, id)}
                  >
                    {editPanel(item.key, item.name, !!item.failed)}
                    {auditorNote(item.key)}
                    <div className="scm-causes">{(item.rootCauses || []).map((cause) => causeRow(cause, `c-${item.key}`))}</div>
                  </Row>
                );
              })}
            </Row>
          </div>
        ) : null}

        {clusters.map((cluster) => {
          const id = rid(`m-${cluster.key}`);
          if (cluster.deterministic && efficiency) {
            const status = metricStatusInfo(efficiency.status);
            return (
              <div role="listitem" key={cluster.key}>
                <Row
                  id={id}
                  level={1}
                  open={!!open[id]}
                  onToggle={() => toggle(id)}
                  name="Efficiency Metrics"
                  meta={`${cluster.earned} / ${cluster.max}`}
                  chip={<Chip tone={status.tone}>{status.label}</Chip>}
                  edit={editButton(cluster.key, 'Efficiency Metrics', id)}
                >
                  {editPanel(cluster.key, 'Efficiency Metrics', !!cluster.failed)}
                  {auditorNote(cluster.key)}
                  <p className="scm-note">Measured by the system from Intercom events, not judged by the AI.</p>
                  {(efficiency.metrics || []).map((metric) => (
                    <EfficiencyMetric key={metric.key} metric={metric} onJump={onJump} canJump={canJump} />
                  ))}
                </Row>
              </div>
            );
          }
          const anyMarked = (cluster.rootCauses || []).some((cause) => cause.marked);
          return (
            <div role="listitem" key={cluster.key}>
              <Row
                id={id}
                level={1}
                open={!!open[id]}
                onToggle={() => toggle(id)}
                name={cluster.name}
                meta={`${cluster.earned} / ${cluster.max}`}
                chip={<Chip tone={cluster.failed ? 'risk' : 'good'}>{cluster.failed ? 'Failed' : 'Met'}</Chip>}
                edit={editButton(cluster.key, cluster.name, id)}
              >
                {editPanel(cluster.key, cluster.name, !!cluster.failed)}
                {auditorNote(cluster.key)}
                {cluster.failed && !anyMarked && !lastEdit(cluster.key) ? <p className="scm-note">Marked failed without a root cause on record.</p> : null}
                <div className="scm-causes">{(cluster.rootCauses || []).map((cause) => causeRow(cause, `m-${cluster.key}`))}</div>
              </Row>
            </div>
          );
        })}

        {!efficiencyCluster && efficiency ? (
          <div role="listitem">
            {(() => {
              const id = rid('efficiency');
              const status = metricStatusInfo(efficiency.status);
              const pts = efficiency.points;
              return (
                <Row
                  id={id}
                  level={1}
                  open={!!open[id]}
                  onToggle={() => toggle(id)}
                  name="Efficiency Metrics"
                  meta={pts && pts.max ? `${pts.earned} / ${pts.max}` : 'Not scored'}
                  chip={<Chip tone={status.tone}>{status.label}</Chip>}
                >
                  <p className="scm-note">Measured by the system. This track does not give Efficiency Metrics points of their own.</p>
                  {(efficiency.metrics || []).map((metric) => (
                    <EfficiencyMetric key={metric.key} metric={metric} onJump={onJump} canJump={canJump} />
                  ))}
                </Row>
              );
            })()}
          </div>
        ) : null}
      </div>

      {(summary.coaching || []).length ? (
        <div className="scm-metrics scm-secondary">
          <Row id={rid('coaching')} level={1} open={!!open[rid('coaching')]} onToggle={() => toggle(rid('coaching'))} name="Coaching" meta={`${summary.coaching.length} suggestion${summary.coaching.length === 1 ? '' : 's'}`}>
            <ul className="scm-plain-list">
              {summary.coaching.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </Row>
        </div>
      ) : null}

      {unverified.length || manualChecks.length ? (
        <div className="scm-metrics scm-secondary">
          <Row
            id={rid('unscored')}
            level={1}
            open={!!open[rid('unscored')]}
            onToggle={() => toggle(rid('unscored'))}
            name="Not scored"
            meta={`${unverified.length + manualChecks.length} item${unverified.length + manualChecks.length === 1 ? '' : 's'}`}
            chip={<Chip tone="watch">Needs a human look</Chip>}
          >
            <p className="scm-note">Nothing here changed the score. These are things the AI raised that could not be confirmed from the transcript or sources.</p>
            {unverified.length ? (
              <div className="scm-unscored">
                <span className="scm-label">Not verified</span>
                <ul>
                  {unverified.map((item, index) => (
                    <li key={index}>
                      <b>{item.rootCauseLabel || item.clusterName || item.cluster || 'Possible finding'}</b>
                      <p>{item.reason}</p>
                      {item.what ? (
                        <p className="scm-claimed">
                          <small>The AI claimed</small>
                          {item.what}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {manualChecks.length ? (
              <div className="scm-unscored">
                <span className="scm-label">Needs internal records</span>
                <ul>
                  {manualChecks.map((item, index) => (
                    <li key={index}>
                      <b>{item.rootCauseLabel || item.clusterName || item.cluster}</b>
                      <p>{item.reason}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Row>
        </div>
      ) : null}

      {edits.length ? (
        <section className="scm-edits">
          <span className="scm-label">Auditor edit history</span>
          <ul>
            {edits.map((entry, index) => (
              <li key={`${entry.key}-${index}`}>
                <b>{entry.name || entry.key}</b>
                <span>
                  {entry.from === 'failed' ? 'Failed' : 'Met'} to {entry.to === 'failed' ? 'failed' : 'met'}
                  {entry.by ? ` by ${entry.by}` : ''}
                  {entry.at && formatDhaka(Date.parse(entry.at) / 1000) ? ` · ${formatDhaka(Date.parse(entry.at) / 1000)}` : ''}
                </span>
                <p>{entry.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result list card (scorecard variant). The caller supplies the conversation line
// (link, copy button, dispute badge) so it matches the legacy card exactly.
// ---------------------------------------------------------------------------
export function ScorecardResultCard({ result, onCompare, conversationLine }) {
  const sc = result.scorecard;
  const outcome = outcomeInfo(sc);
  const failed = (sc.clusters || []).filter((cluster) => cluster.failed);
  const metrics = (sc.efficiency?.metrics || []).filter((metric) => metric.key !== 'resolution');
  return (
    <article className="audit-result-card scm-card">
      <div className="result-summary">
        <div className="result-agent">
          {conversationLine}
          <h3>{result.agentName}</h3>
          <div className="scm-chips">
            <Chip tone="none">{trackLabel(sc)}</Chip>
            <Chip tone={outcome.tone} strong={outcome.strong}>
              {outcome.label}
            </Chip>
            {sc.manualReview ? <Chip tone="watch">Manual review</Chip> : null}
          </div>
          {failed.length ? (
            <div className="scm-chips" aria-label="Failed metrics">
              {failed.slice(0, 3).map((cluster) => (
                <Chip key={cluster.key} tone="risk">
                  {cluster.name}
                </Chip>
              ))}
              {failed.length > 3 ? <Chip tone="none">+{failed.length - 3} more</Chip> : null}
            </div>
          ) : null}
          {metrics.length ? (
            <div className="scm-chips" role="group" aria-label="Efficiency Metrics">
              {metrics.map((metric) => {
                const status = metricStatusInfo(metric.status);
                const hasValue = metric.value !== null && metric.value !== undefined;
                const target = targetText(metric);
                return (
                  <Chip key={metric.key} tone={status.tone} title={`${metric.label}: ${status.label}${target ? ` (target ${target})` : ''}`}>
                    {efficiencyShort(metric.key)} {hasValue ? secondsText(metric.value) : 'n/a'}
                  </Chip>
                );
              })}
            </div>
          ) : null}
        </div>
        <ScorecardRing percent={percentOf(sc)} tone={outcome.tone} />
        <button type="button" className="view-result-button" onClick={() => onCompare(result)}>
          <span>View result</span>
          <i>→</i>
        </button>
      </div>
    </article>
  );
}
