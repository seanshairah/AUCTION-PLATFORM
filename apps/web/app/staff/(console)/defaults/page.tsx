import { CheckIcon, ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { Action } from '@/components/staff/Action';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import { can, staffMe, words } from '@/lib/staff';
import type { Money } from '@/lib/types';

export const metadata = { title: 'Late payments' };

interface Case {
  caseId: string; status: string; openedAt: string; closedAt: string | null;
  invoice: { id: string; number: string; currency: string; total: Money; status: string; dueAt: string };
  buyer: { id: string; name: string }; stepsApplied: string[];
  waivers: Array<{ step: string; effect: string; at: string }>;
  appeals: Array<{ id: string; steps: string[]; grounds: string; status: string; raisedVia: string; raisedAt: string; decisionNote: string | null }>;
  pendingWaivers: Array<{ overrideId: string; step: string }>;
}

const STEP: Record<string, string> = { deposit_forfeit: 'Deposit forfeited', relist_fee: 'Relisting fee', tier_drop: 'Tier lowered' };
const TABS = [['open', 'Open'], ['cured', 'Cured'], ['waived', 'Waived'], ['completed', 'Completed']] as const;

export default async function DefaultsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const me = (await staffMe())!;
  const { status = 'open' } = await searchParams;
  const list = await apiOrNull<Case[]>(`/staff/defaults?status=${encodeURIComponent(status)}`);
  if (!list) return <div className="notice bad">Your role cannot see late-payment cases.</div>;
  return (
    <>
      <div className="con-title">
        <div>
          <span className="eyebrow"><ExclamationTriangleIcon /> Deliverable 18 · Defaults</span>
          <h1>Late payments</h1>
          <p>When an invoice passes its pay window the rulebook applies its steps: deposit forfeit, relisting fee, a lower tier. Buyers can appeal; a waiver reverses a step through the ledger and needs a second person above the threshold.</p>
        </div>
        <nav className="seg-tabs" aria-label="Status">
          {TABS.map(([k, label]) => <Link key={k} href={`/staff/defaults?status=${k}`} className={status === k ? 'on' : ''}>{label}</Link>)}
        </nav>
      </div>

      {list.length === 0 ? (
        <div className="pnl"><div className="empty"><CheckIcon /><b>No {words(status).toLowerCase()} cases</b><span>Cases open automatically when an invoice passes its pay window.</span></div></div>
      ) : (
        <div className="pnl">
          <div className="body flush">
            <table className="table">
              <thead><tr><th>Buyer</th><th>Invoice</th><th className="r">Total</th><th>Steps applied</th><th>Appeals</th><th>Actions</th></tr></thead>
              <tbody>{list.map((c) => {
                const open = c.appeals.filter((a) => a.status === 'open' || a.status === 'pending');
                return (
                  <tr key={c.caseId} style={{ verticalAlign: 'top' }}>
                    <td><span className="w500">{c.buyer.name}</span><br /><span className="micro">Opened {shortDateTime(c.openedAt)}</span></td>
                    <td className="small"><span className="mono">{c.invoice.number}</span><br /><span className="muted">Due {shortDateTime(c.invoice.dueAt)}</span></td>
                    <td className="r mono">{c.invoice.total.text}</td>
                    <td><div className="stack-8">{c.stepsApplied.length ? c.stepsApplied.map((s) => {
                      const waived = c.waivers.some((w) => w.step === s);
                      const pending = c.pendingWaivers.some((w) => w.step === s);
                      return <span key={s} className={`status ${waived ? 'good' : pending ? 'warn' : 'bad'}`}>{waived ? <CheckIcon /> : <span className="ring" />}{STEP[s] ?? words(s)}{waived ? ' · waived' : pending ? ' · waiver waiting' : ''}</span>;
                    }) : <span className="muted small">None yet</span>}</div></td>
                    <td style={{ maxWidth: 320 }}>{c.appeals.length === 0 ? <span className="muted small">None</span> : c.appeals.map((a) => (
                      <div key={a.id} className="stack-8" style={{ marginBottom: 8 }}>
                        <span className="small"><span className="chip">{words(a.status)}</span> via {a.raisedVia}</span>
                        <span className="small ink-2">“{a.grounds}”</span>
                        {a.decisionNote && <span className="small muted">Decision: {a.decisionNote}</span>}
                      </div>
                    ))}</td>
                    <td>
                      <div className="stack-8">
                        {can(me, 'default.appeal.decide') && open.map((a) => (
                          <div key={a.id} className="btn-group">
                            <Action url={`/staff/appeals/${a.id}/decision`} body={{ decision: 'upheld' }} label="Uphold" note="note:Decision note for the buyer" icon={<CheckIcon />} />
                            <Action url={`/staff/appeals/${a.id}/decision`} body={{ decision: 'rejected' }} label="Reject" tone="danger" note="note:Why is the appeal rejected?" icon={<XMarkIcon />} />
                          </div>
                        ))}
                        {can(me, 'default.waiver.request') && c.status === 'open' && c.stepsApplied.filter((s) => !c.waivers.some((w) => w.step === s) && !c.pendingWaivers.some((w) => w.step === s)).map((s) => (
                          <Action key={s} url={`/staff/defaults/${c.caseId}/waivers`} body={{ step: s, clientKey: `${c.caseId}-${s}` }} label={`Waive: ${STEP[s] ?? words(s)}`} note="reason:Why waive it? (kept in the audit log)" done="Waiver raised." />
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
