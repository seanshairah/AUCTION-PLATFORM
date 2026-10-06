import { ArrowUpTrayIcon, ChevronRightIcon, PlusIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { Countdown } from '@/components/Countdown';
import { apiOrNull } from '@/lib/api';
import type { Money } from '@/lib/types';

export const metadata = { title: 'Selling' };

interface Overview {
  lots: Array<{ ref: string; title: string; state: string; currentPrice: Money | null; bids: number; bidders: number; reserve: Money | null; reserveMet: boolean | null; endsAt: string | null }>;
  payouts: Array<{ id: string; status: string; dueDate: string; gross: Money; deductions: Money; net: Money }>;
  totals: Array<{ currency: string; paid: Money; upcoming: Money; held: Money; nextDueDate: string | null }>;
  consignments: Array<{ id: string; status: string; type: string; branch: string; channel: string; createdAt: string; lots: number }>;
}

const STATE: Record<string, string> = { draft: 'Draft', listed: 'Listed', live: 'Live', closed: 'Closed', invoiced: 'Invoiced', paid: 'Paid', title_hold: 'Title in progress', released: 'Collected', unsold: 'Unsold', reserve_not_met: 'Reserve not met', withdrawn: 'Withdrawn' };

export default async function SellingPage() {
  const o = await apiOrNull<Overview>('/seller/overview');
  if (!o) return <p>Could not load your selling overview.</p>;
  const usd = o.totals.find((t) => t.currency === 'USD');
  const live = o.lots.filter((l) => l.state === 'live');
  const met = live.filter((l) => l.reserveMet || l.reserve === null).length;
  return (
    <>
      <div className="acc-title">
        <div>
          <h1>Selling</h1>
          <p>Your lots live, against your own reserve, and every payout with its date.</p>
        </div>
        <div className="btn-group">
          <Link href="/account/selling/bulk" className="btn ghost"><ArrowUpTrayIcon /> Bulk upload</Link>
          <Link href="/account/selling/new" className="btn"><PlusIcon /> New consignment</Link>
        </div>
      </div>
      <div className="kpis" style={{ ['--n' as string]: 4, marginBottom: 16 }}>
        <div className="kpi"><span className="micro">Live lots</span><span className="v">{live.length}</span></div>
        <div className="kpi"><span className="micro">Reserve met or none</span><span className="v">{met} of {live.length}</span></div>
        <div className="kpi"><span className="micro">Upcoming payouts</span><span className="v">{usd?.upcoming.text ?? 'US$0.00'}</span></div>
        <div className="kpi"><span className="micro">Paid to you</span><span className="v">{usd?.paid.text ?? 'US$0.00'}</span></div>
      </div>

      <div className="nest" style={{ marginBottom: 16 }}>
        <div className="nest-head"><h3>Your lots</h3><span className="badge">{o.lots.length}</span></div>
        <div className="nest-body" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Lot</th><th>State</th><th className="r">Current price</th><th className="r">Bids</th><th className="r">Your reserve</th><th>Reserve</th><th>Ends</th></tr></thead>
            <tbody>
              {o.lots.map((l) => (
                <tr key={l.ref}>
                  <td><Link href={`/lots/${encodeURIComponent(l.ref)}`} className="w500">{l.title}</Link><br /><span className="micro">{l.ref}</span></td>
                  <td><span className="status neutral"><span className="ring" style={l.state === 'live' ? { background: 'var(--good)', borderColor: 'var(--good)' } : undefined} />{STATE[l.state] ?? l.state}</span></td>
                  <td className="r mono">{l.currentPrice?.text ?? '—'}</td>
                  <td className="r mono">{l.bids} <span className="muted">· {l.bidders}</span></td>
                  <td className="r mono">{l.reserve?.text ?? 'None'}</td>
                  <td>{l.reserve === null ? <span className="status good">No reserve</span> : l.reserveMet ? <span className="status good">Met</span> : <span className="status neutral"><span className="ring" />Not yet</span>}</td>
                  <td>{l.endsAt && l.state === 'live' ? <Countdown endsAt={l.endsAt} /> : <span className="muted small">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="nest" style={{ marginBottom: 16 }}>
        <div className="nest-head"><h3>Consignments</h3><span className="badge">{o.consignments.length}</span></div>
        <div className="nest-body" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>Started</th><th>Branch</th><th>Channel</th><th className="r">Lots</th><th>Status</th><th /></tr></thead>
            <tbody>
              {o.consignments.map((c) => (
                <tr key={c.id}>
                  <td className="small">{new Date(c.createdAt).toLocaleDateString('en-ZW', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                  <td>{c.branch === 'HRE' ? 'Harare' : 'Bulawayo'}</td>
                  <td className="small ink-2">{c.channel}</td>
                  <td className="r mono">{c.lots}</td>
                  <td><span className={`status ${c.status === 'signed' ? 'good' : 'neutral'}`}><span className="ring" style={c.status === 'signed' ? { background: 'currentColor' } : undefined} />{c.status === 'signed' ? 'Signed' : c.status === 'draft' ? 'Draft' : c.status}</span></td>
                  <td className="r"><Link href={`/account/selling/consignments/${c.id}`} className="btn sm ghost">Open <ChevronRightIcon /></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="nest">
        <div className="nest-head"><h3>Payouts</h3><span className="badge">{o.payouts.length}</span></div>
        <div className="nest-body" style={{ padding: o.payouts.length ? 0 : 16 }}>
          {o.payouts.length === 0 ? <p className="muted">No payouts yet. A payout is scheduled when the buyer collects and the claim window ends.</p> : (
            <table className="table">
              <thead><tr><th>Due</th><th>Status</th><th className="r">Gross</th><th className="r">Deductions</th><th className="r">Net</th></tr></thead>
              <tbody>{o.payouts.map((p) => <tr key={p.id}><td className="mono small">{p.dueDate}</td><td>{p.status}</td><td className="r mono">{p.gross.text}</td><td className="r mono">{p.deductions.text}</td><td className="r mono w500">{p.net.text}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
