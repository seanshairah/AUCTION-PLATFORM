import { BookOpenIcon, CheckCircleIcon, ExclamationTriangleIcon, ReceiptPercentIcon, XCircleIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { Action } from '@/components/staff/Action';
import { AckAll } from '@/components/staff/AckAll';
import { Publish } from '@/components/staff/Publish';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import { can, staffMe, words } from '@/lib/staff';

export const metadata = { title: 'Rulebook' };

interface RuleSet { id: string; label: string; status: string; effectiveFrom: string; authoredBy: string; approvedBy: string | null; publishedAt: string | null; rules: number; inForce: boolean }
interface Validation {
  versionId: string; label: string; status: string; authoredBy: string; effectiveFrom: string;
  errors: Array<{ code: string; key?: string; message: string }>;
  warnings: Array<{ id: string; code: string; key: string; message: string; acknowledgements: Array<{ by: string; name?: string; reason: string; at: string }> }>;
  changedKeys: string[]; approverRoles: string[]; readyForYou: boolean; openForYou: number;
}
interface TaxRate { id: string; taxCode: string; taxClass: string; currency: string; rateBp: number; base: string; effectiveFrom: string; effectiveTo: string | null; active: boolean; provenance: string; source: string; pendingActivation: string | null }

const TAX: Record<string, string> = { vat: 'VAT', purchasers_levy: 'Purchaser’s levy' };
const PROV: Record<string, string> = { confirmed: 'good', assumption: 'warn', benchmark: 'info' };

export default async function RulebookPage({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  const me = (await staffMe())!;
  const { v } = await searchParams;
  const [sets, rates] = await Promise.all([apiOrNull<RuleSet[]>('/staff/rule-sets'), can(me, 'tax_rate.view') ? apiOrNull<TaxRate[]>('/staff/tax-rates') : null]);
  if (!sets) return <div className="notice bad">Your role cannot see the rulebook.</div>;
  const selected = sets.find((s) => s.id === v) ?? sets.find((s) => s.status === 'draft') ?? sets.find((s) => s.inForce) ?? sets[0];
  const val = selected ? await apiOrNull<Validation>(`/staff/rule-sets/${selected.id}/validation`) : null;
  const mineLeft = val ? val.warnings.filter((w) => !w.acknowledgements.some((a) => a.by === me.id)) : [];
  const acked = val ? val.warnings.length - mineLeft.length : 0;
  const isAuthor = val?.authoredBy === me.id;
  const approver = can(me, 'rulebook.approve');
  return (
    <>
      <div className="con-title">
        <div>
          <span className="eyebrow"><BookOpenIcon /> R2 · One versioned rulebook</span>
          <h1>Rulebook</h1>
          <p>Every fee, limit, deadline and tax is a rule in a dated, versioned set. A draft is published only after a second person reads and acknowledges each warning; quotes and auctions pin the version in force when they start.</p>
        </div>
        <Link href="/rules" className="btn ghost">Public rulebook</Link>
      </div>

      <div className="cgrid">
        <section className="pnl c-4">
          <header><BookOpenIcon /><h2>Rule sets</h2></header>
          <div className="body flush">
            {sets.map((s) => (
              <Link key={s.id} href={`/staff/rulebook?v=${s.id}`} className="row" style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)', gap: 12, background: s.id === selected?.id ? 'var(--accent-tint)' : undefined }}>
                <div className="grow">
                  <div className="row" style={{ gap: 8 }}><span className="mono w500">{s.label}</span>{s.inForce && <span className="chip accent">In force</span>}</div>
                  <div className="small muted" style={{ marginTop: 2 }}>{words(s.status)} · {s.rules} rules · from {shortDateTime(s.effectiveFrom)}</div>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section className="pnl c-8">
          <header>
            <ExclamationTriangleIcon /><h2>{val ? `${val.label}: validation` : 'Validation'}</h2>
            {val && <span className="right"><span className="chip">{words(val.status)}</span></span>}
          </header>
          {!val ? <div className="empty">No rule set selected.</div> : (
            <>
              <div className="body stack" style={{ borderBottom: '1px solid var(--line)' }}>
                <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
                  <div className="stack-8"><span className="micro">Errors</span><span className={`mono w500`} style={{ fontSize: 22, color: val.errors.length ? 'var(--bad)' : undefined }}>{val.errors.length}</span></div>
                  <div className="stack-8"><span className="micro">Warnings</span><span className="mono w500" style={{ fontSize: 22 }}>{val.warnings.length}</span></div>
                  <div className="stack-8"><span className="micro">Changed rules</span><span className="mono w500" style={{ fontSize: 22 }}>{val.changedKeys.length}</span></div>
                  <div className="stack-8"><span className="micro">Needs sign-off from</span><span className="row" style={{ gap: 4 }}>{val.approverRoles.length ? val.approverRoles.map((r) => <span key={r} className="chip">{r}</span>) : <span className="small muted">Any approver</span>}</span></div>
                </div>
                {val.status === 'draft' && val.warnings.length > 0 && (
                  <div className="progress"><span className="micro">You have acknowledged</span><div className="meter"><i style={{ width: `${(acked / val.warnings.length) * 100}%` }} /></div><span className="mono small">{acked}/{val.warnings.length}</span></div>
                )}
                {val.status === 'draft' && (
                  isAuthor ? <div className="notice neutral small">You authored this draft, so another person must acknowledge and publish it.</div>
                  : !approver ? <div className="notice neutral small">Your role can read this draft but not approve it.</div>
                  : val.errors.length ? <div className="notice bad small">Fix the errors before this draft can be published.</div>
                  : mineLeft.length ? <AckAll versionId={val.versionId} warningIds={mineLeft.map((w) => w.id)} />
                  : <Publish versionId={val.versionId} defaultFrom={new Date(Math.max(Date.now() + 3_600_000, new Date(val.effectiveFrom).getTime())).toISOString()} />
                )}
              </div>
              <div className="body flush" style={{ maxHeight: 560, overflowY: 'auto' }}>
                {val.errors.map((e, i) => (
                  <div key={`e${i}`} className="warn-row"><XCircleIcon style={{ color: 'var(--bad)' }} /><div><div className="small w500">{e.message}</div>{e.key && <code>{e.key}</code>}</div><span /></div>
                ))}
                {val.warnings.length === 0 && val.errors.length === 0 && <div className="empty"><CheckCircleIcon /><b>Clean</b><span>No errors or warnings.</span></div>}
                {val.warnings.map((w) => {
                  const mine = w.acknowledgements.some((a) => a.by === me.id);
                  return (
                    <div key={w.id} className="warn-row">
                      {mine ? <CheckCircleIcon style={{ color: 'var(--good)' }} /> : <ExclamationTriangleIcon style={{ color: 'var(--warn)' }} />}
                      <div style={{ minWidth: 0 }}>
                        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><code>{w.key}</code><span className="micro">{words(w.code.replace('provenance_', ''))}</span></div>
                        <div className="small ink-2" style={{ marginTop: 6 }}>{w.message.replace(`${w.key} (global) `, '')}</div>
                        {w.acknowledgements.length > 0 && <div className="small muted" style={{ marginTop: 4 }}>Acknowledged by {w.acknowledgements.length} {w.acknowledgements.length === 1 ? 'person' : 'people'}</div>}
                      </div>
                      {val.status === 'draft' && approver && !isAuthor && !mine ? <Action url={`/staff/rule-sets/${val.versionId}/acknowledgements`} body={{ warningId: w.id }} label="Acknowledge" note="reason:Why is this acceptable?" done="Acknowledged." /> : <span />}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {rates && (
          <section className="pnl c-12">
            <header><ReceiptPercentIcon /><h2>Tax rates</h2><span className="right small muted">Activating a rate is a two-person change</span></header>
            <div className="body flush">
              <table className="table">
                <thead><tr><th>Tax</th><th>Class</th><th>Currency</th><th className="r">Rate</th><th>Base</th><th>From</th><th>Source</th><th>Status</th></tr></thead>
                <tbody>{rates.map((t) => (
                  <tr key={t.id} style={{ verticalAlign: 'top' }}>
                    <td className="w500">{TAX[t.taxCode] ?? words(t.taxCode)}</td>
                    <td className="small">{words(t.taxClass).replace(/ zw$/, ' (ZW)')}</td>
                    <td className="mono small">{t.currency}</td>
                    <td className="r mono">{(t.rateBp / 100).toFixed(2)}%</td>
                    <td className="small">{words(t.base)}</td>
                    <td className="small">{shortDateTime(t.effectiveFrom)}</td>
                    <td className="small" style={{ maxWidth: 360 }}><span className={`status ${PROV[t.provenance] ?? 'neutral'}`}><span className="ring" /> {words(t.provenance)}</span><div className="muted" style={{ marginTop: 4 }}>{t.source}</div></td>
                    <td>
                      {t.active ? <span className="status good"><CheckCircleIcon /> Active</span>
                        : t.pendingActivation ? <Link href="/staff/approvals" className="status warn"><span className="ring" /> Waiting for approval</Link>
                        : can(me, 'tax_rate.activation.request') ? <Action url="/staff/overrides" body={{ kind: 'tax_rate_activation', payload: { taxRateId: t.id }, clientKey: `tax-${t.id}` }} label="Request activation" note="reason:Source of the confirmed rate (e.g. ZIMRA notice)" done="Sent for a second approval." />
                        : <span className="status neutral"><span className="ring" /> Inactive</span>}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
