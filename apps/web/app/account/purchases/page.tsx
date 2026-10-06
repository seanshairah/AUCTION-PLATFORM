import { CheckCircleIcon, ClockIcon, ExclamationTriangleIcon, QrCodeIcon, ShoppingBagIcon, TruckIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { Countdown } from '@/components/Countdown';
import { CollectionSlot } from '@/components/purchases/CollectionSlot';
import { PayInvoice } from '@/components/purchases/PayInvoice';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import type { Money } from '@/lib/types';

export const metadata = { title: 'Purchases' };

interface Purchase {
  invoiceId: string; invoiceNumber: string; auction: string; status: string; total: Money; issuedAt: string; dueAt: string; paidAt: string | null;
  lots: Array<{ id: string; ref: string; title: string; state: string; isVehicle: boolean; branch: string; lines: Array<{ type: string; description: string; amount: Money }>;
    titleCase: { status: string; deadlineAt: string; done: number; total: number; steps: Array<{ step: string; status: string; dueAt: string; completedAt: string | null }> } | null;
    dispute: { id: string; status: string } | null }>;
  collection: { id: string; status: string; method: string; branch: string; gatePass: string; releasedAt: string | null; slot: { id: string; startsAt: string; endsAt: string } | null;
    storage: { enabled: boolean; collectBy: string; freeUntil: string; days: number; accrued: Money } | null } | null;
}

const STEP: Record<string, string> = { zrp_clearance: 'ZRP police clearance', zimra_clearance: 'ZIMRA clearance', cvr_change_of_ownership: 'CVR change of ownership' };
const STATUS: Record<string, [string, string]> = { issued: ['Payment due', 'warn'], overdue: ['Overdue', 'bad'], paid: ['Paid', 'good'], void: ['Cancelled', 'neutral'] };

export default async function PurchasesPage() {
  const purchases = (await apiOrNull<Purchase[]>('/me/purchases')) ?? [];
  return (
    <>
      <div className="acc-title">
        <div><h1>Purchases</h1><p>Everything you won: pay in one tap, choose when to collect, and follow vehicle paperwork to release.</p></div>
      </div>
      {purchases.length === 0 && <div className="card empty"><ShoppingBagIcon /><h3 className="w600">Nothing won yet</h3><p>When you win a lot, the invoice appears here at the close.</p><Link className="btn sm" href="/auctions">Browse the docket</Link></div>}
      <div className="stack">
        {purchases.map((p) => {
          const [label, tone] = STATUS[p.status] ?? [p.status, 'neutral'];
          const c = p.collection;
          return (
            <section key={p.invoiceId} className="nest">
              <div className="nest-head" style={{ flexWrap: 'wrap' }}>
                <h3>Invoice <span className="mono">{p.invoiceNumber}</span></h3>
                <span className="muted small">{p.auction}</span>
                <span style={{ marginLeft: 'auto' }} className={`status ${tone}`}>{tone === 'good' ? <CheckCircleIcon /> : tone === 'bad' ? <ExclamationTriangleIcon /> : <ClockIcon />}{label}</span>
              </div>
              <div className="nest-body split">
                <div className="stack">
                  {p.lots.map((l) => (
                    <div key={l.id} className="stack-8">
                      <div className="row between"><Link href={`/lots/${encodeURIComponent(l.ref)}`} className="w600">{l.title}</Link><span className="micro">{l.ref}</span></div>
                      <div className="lines">
                        {l.lines.map((x) => <div key={x.type + x.description} className="l"><span>{x.description}</span><span>{x.amount.text}</span></div>)}
                      </div>
                      {l.titleCase && (
                        <div className="card" style={{ padding: 14 }}>
                          <div className="row between" style={{ marginBottom: 8 }}><span className="micro">Title transfer · {l.titleCase.done} of {l.titleCase.total} done</span><span className="small muted">Due {shortDateTime(l.titleCase.deadlineAt)}</span></div>
                          <div className="timeline">
                            {l.titleCase.steps.map((s) => (
                              <div key={s.step} className={`tl-item${s.status === 'done' ? ' top' : ''}`}>
                                <span className="who">{STEP[s.step] ?? s.step}</span>
                                <span className={`status ${s.status === 'done' ? 'good' : 'neutral'}`}>{s.status === 'done' ? <><CheckCircleIcon /> Done</> : <><span className="ring" /> {s.status === 'in_progress' ? 'In progress' : 'Waiting'}</>}</span>
                                <span className="when">{s.completedAt ? `Completed ${shortDateTime(s.completedAt)}` : `Due ${shortDateTime(s.dueAt)}`}</span>
                              </div>
                            ))}
                          </div>
                          <p className="small muted" style={{ marginTop: 8 }}>The vehicle is released once all three steps are complete. ABC&apos;s vehicle desk handles them with the agencies.</p>
                        </div>
                      )}
                      {l.dispute ? <span className="status info">Claim {l.dispute.status.replace('_', ' ')}</span> : c?.releasedAt ? <Link className="link small" href={`/account/support?claim=${l.id}`}>Report a problem with this lot</Link> : null}
                    </div>
                  ))}
                  <div className="lines"><div className="l total"><span>Invoice total</span><span>{p.total.text}</span></div></div>
                </div>
                <div className="stack">
                  {(p.status === 'issued' || p.status === 'overdue') && (
                    <div className="card" style={{ padding: 16 }}>
                      <div className="row between" style={{ marginBottom: 10 }}><span className="micro">Pay by</span><span className="small">{shortDateTime(p.dueAt)} · <Countdown endsAt={p.dueAt} /></span></div>
                      <PayInvoice invoiceId={p.invoiceId} total={p.total.text} />
                    </div>
                  )}
                  {c && (
                    <div className="card" style={{ padding: 16 }}>
                      <div className="micro" style={{ marginBottom: 10 }}>Collection · {c.branch === 'HRE' ? 'Harare' : c.branch === 'BYO' ? 'Bulawayo' : c.branch}</div>
                      <div className="stack-8">
                        <span className={`status ${c.gatePass === 'valid' ? 'good' : 'neutral'}`}><QrCodeIcon /> Gate pass {c.gatePass === 'valid' ? 'ready' : c.gatePass === 'used' ? 'used' : c.gatePass.replace('_', ' ')}</span>
                        {c.releasedAt ? <span className="status good"><CheckCircleIcon /> Collected {shortDateTime(c.releasedAt)}</span> : (
                          <>
                            {c.slot ? <span className="small">Collection booked for <span className="w600">{shortDateTime(c.slot.startsAt)}</span></span> : <span className="small ink-2">Choose a time to collect:</span>}
                            <CollectionSlot collectionId={c.id} branch={c.branch} current={c.slot} />
                          </>
                        )}
                        {c.storage && !c.releasedAt && (
                          <span className="small muted">Collect by {shortDateTime(c.storage.collectBy)}.{c.storage.enabled ? ` Storage after ${shortDateTime(c.storage.freeUntil)}: ${c.storage.accrued.text} so far.` : ' No storage is charged.'}</span>
                        )}
                        {c.method === 'pickup' && !c.releasedAt && !p.lots.some((l) => l.isVehicle) && <span className="small muted row"><TruckIcon width={14} /> Delivery opens once ABC publishes its delivery rates.</span>}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
