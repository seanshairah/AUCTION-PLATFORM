import {
  BanknotesIcon, CalendarDaysIcon, CheckBadgeIcon, ChevronRightIcon, ClockIcon, DocumentTextIcon, EyeIcon, Squares2X2Icon,
} from '@heroicons/react/20/solid';
import Link from 'next/link';
import { Countdown } from '@/components/Countdown';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import { approvableBy, canSee, plainName, relative, staffMe, words } from '@/lib/staff';
import type { Money } from '@/lib/types';

export const metadata = { title: 'Today' };

interface Dashboard {
  asOf: string;
  closingToday: Array<{ auctionLotId: string; lotRef: string; title: string; auctionCode: string; branch: string; currentPrice: Money | null; endsAt: string; reserveMet: boolean; bids: number }>;
  unpaidInvoices: Array<{ bucket: string; currency: string; count: number; total: Money }>;
  payoutsDue: Array<{ currency: string; count: number; net: Money; overdue: number }>;
  titleCasesOverdue: Array<{ titleCaseId: string; lotRef: string; title: string; buyer: string; deadlineAt: string; status: string; nextStep: string | null }>;
  viewings: Array<{ slotId: string; branch: string; lotRef: string | null; startsAt: string; endsAt: string; capacity: number; booked: number }>;
}
interface StaffAuction { id: string; code: string; title: string; branch: string; status: string; opensAt: string; firstCloseAt: string; lots: number; bids: number }
interface Override { id: string; kind: string; amount: Money | null; reason: string; requestedBy: { id: string; name: string }; requestedAt: string; expiresAt: string | null; payload: { summary?: string } }

const BUCKETS: Array<{ key: string; label: string; colour: string }> = [
  { key: 'within_pay_window', label: 'Within pay window', colour: '#9a98c9' },
  { key: 'overdue_under_24h', label: 'Overdue < 24h', colour: '#e3a33a' },
  { key: 'overdue_24_to_72h', label: '24–72h', colour: '#d0702a' },
  { key: 'overdue_over_72h', label: 'Over 72h', colour: '#c8412b' },
];

function sum(items: Array<{ total: Money }>): string {
  if (!items.length) return 'US$0';
  const minor = items.reduce((a, i) => a + BigInt(i.total.minor), 0n);
  return `US$${(Number(minor) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export default async function TodayPage() {
  const me = (await staffMe())!;
  const [dash, auctions, overrides] = await Promise.all([
    apiOrNull<Dashboard>('/staff/dashboard'),
    apiOrNull<StaffAuction[]>('/staff/auctions'),
    canSee(me, 'override.view') ? apiOrNull<Override[]>('/staff/overrides?status=pending') : null,
  ]);
  const usdUnpaid = (dash?.unpaidInvoices ?? []).filter((u) => u.currency === 'USD');
  const unpaidCount = usdUnpaid.reduce((a, u) => a + u.count, 0);
  const overdueCount = usdUnpaid.filter((u) => u.bucket !== 'within_pay_window').reduce((a, u) => a + u.count, 0);
  const live = (auctions ?? []).filter((a) => a.status === 'open' || a.status === 'closing');
  const upcoming = (auctions ?? []).filter((a) => a.status === 'scheduled' || a.status === 'draft');
  const waiting = approvableBy(me, overrides ?? []);
  const totalMinor = usdUnpaid.reduce((a, u) => a + Number(u.total.minor), 0) || 1;
  const hour = Number(new Date().toLocaleString('en-ZW', { hour: '2-digit', hour12: false, timeZone: 'Africa/Harare' }));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <div className="con-title">
        <div>
          <span className="eyebrow"><Squares2X2Icon /> {new Date().toLocaleDateString('en-ZW', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Harare' })}</span>
          <h1>{greeting}, {plainName(me.name).split(' ')[0]}</h1>
          <p>What closes today, what is owed, and what is waiting for a second person. Figures are live from the ledger and the auction engine.</p>
        </div>
        {canSee(me, 'auction.schedule') && <Link href="/staff/auctions" className="btn ink"><CalendarDaysIcon /> Schedule an auction</Link>}
      </div>

      <div className="kband" style={{ ['--n' as string]: 5 }}>
        <div><span className="micro">Live auctions</span><span className="v">{live.length}<small>{live.reduce((a, l) => a + l.lots, 0)} lots</small></span><span className="s">{live.reduce((a, l) => a + l.bids, 0)} bids so far</span></div>
        <div><span className="micro">Closing today</span><span className="v">{dash?.closingToday.length ?? 0}</span><span className="s">{(dash?.closingToday ?? []).filter((c) => !c.reserveMet).length} below reserve</span></div>
        <div><span className="micro">Unpaid invoices</span><span className={`v${overdueCount ? ' urgent' : ''}`}>{sum(usdUnpaid)}</span><span className="s">{unpaidCount} invoice{unpaidCount === 1 ? '' : 's'} · {overdueCount} overdue</span></div>
        <div><span className="micro">Waiting for you</span>{canSee(me, 'override.view') ? <Link href="/staff/approvals" className={`v${waiting.length ? ' urgent' : ''}`}>{waiting.length}</Link> : <span className="v">—</span>}<span className="s">Two-person approvals</span></div>
        <div><span className="micro">Payouts due</span><span className="v">{(dash?.payoutsDue ?? []).reduce((a, p) => a + p.count, 0)}</span><span className="s">{(dash?.payoutsDue ?? []).map((p) => p.net.text).join(' · ') || 'Nothing due'}</span></div>
      </div>

      <div className="cgrid">
        <section className="pnl c-8">
          <header><ClockIcon /><h2>Closing today</h2><span className="badge">{dash?.closingToday.length ?? 0}</span><span className="right micro">Soft close extends on late bids</span></header>
          <div className="body flush">
            {(dash?.closingToday ?? []).length === 0 ? (
              <div className="empty"><ClockIcon /><b>Nothing closes today</b><span>{live.length ? `Next close: ${live.map((l) => shortDateTime(l.firstCloseAt)).sort()[0]}` : 'No auction is open.'}</span></div>
            ) : (
              <table className="table">
                <thead><tr><th>Lot</th><th>Auction</th><th className="r">Bids</th><th className="r">Current</th><th>Reserve</th><th className="r">Closes in</th></tr></thead>
                <tbody>{dash!.closingToday.map((c) => (
                  <tr key={c.auctionLotId}>
                    <td><Link href={`/lots/${c.lotRef}`} className="w500 link">{c.title}</Link><br /><span className="micro">{c.lotRef}</span></td>
                    <td className="small">{c.auctionCode}<br /><span className="muted">{c.branch}</span></td>
                    <td className="r mono">{c.bids}</td>
                    <td className="r mono">{c.currentPrice?.text ?? '—'}</td>
                    <td>{c.reserveMet ? <span className="status good"><CheckBadgeIcon /> Met</span> : <span className="status warn"><span className="ring" /> Not met</span>}</td>
                    <td className="r mono"><Countdown endsAt={c.endsAt} /></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </section>

        <section className="pnl c-4">
          <header><CheckBadgeIcon /><h2>Waiting for a second person</h2>{waiting.length > 0 && <span className="badge urgent">{waiting.length}</span>}</header>
          <div className="body flush">
            {!canSee(me, 'override.view') ? <div className="empty left">Your role does not see approvals.</div>
              : waiting.length === 0 ? <div className="empty"><CheckBadgeIcon /><b>Nothing waiting</b><span>Requests above the threshold appear here.</span></div>
              : waiting.slice(0, 4).map((o) => (
                <Link key={o.id} href="/staff/approvals" className="row" style={{ padding: '14px 16px', borderBottom: '1px solid var(--line-soft)', alignItems: 'flex-start', gap: 12 }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}><span className="chip">{words(o.kind)}</span>{o.amount && <span className="mono w500">{o.amount.text}</span>}</div>
                    <div className="small ink-2" style={{ marginTop: 6 }}>{o.reason}</div>
                    <div className="micro" style={{ marginTop: 6 }}>{plainName(o.requestedBy.name)} · {relative(o.requestedAt)}{o.expiresAt ? ` · lapses ${relative(o.expiresAt)}` : ''}</div>
                  </div>
                  <ChevronRightIcon width={16} className="muted" />
                </Link>
              ))}
          </div>
        </section>

        <section className="pnl c-6">
          <header><BanknotesIcon /><h2>Unpaid invoices by age</h2><span className="right mono small">{sum(usdUnpaid)}</span></header>
          <div className="body stack">
            {usdUnpaid.length === 0 ? <div className="empty"><BanknotesIcon /><b>Everything is paid</b></div> : (
              <>
                <div className="aging" role="img" aria-label="Unpaid invoice totals by age">
                  {BUCKETS.map((b) => {
                    const u = usdUnpaid.find((x) => x.bucket === b.key);
                    return u ? <i key={b.key} title={`${b.label}: ${u.total.text}`} style={{ width: `${(Number(u.total.minor) / totalMinor) * 100}%`, background: b.colour }} /> : null;
                  })}
                </div>
                <table className="table">
                  <thead><tr><th>Age</th><th className="r">Invoices</th><th className="r">Total</th></tr></thead>
                  <tbody>{BUCKETS.map((b) => {
                    const u = usdUnpaid.find((x) => x.bucket === b.key);
                    return (
                      <tr key={b.key}>
                        <td><span className="row" style={{ gap: 8 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: b.colour, display: 'inline-block' }} />{b.label}</span></td>
                        <td className="r mono">{u?.count ?? 0}</td>
                        <td className="r mono">{u?.total.text ?? '—'}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </>
            )}
          </div>
        </section>

        <section className="pnl c-6">
          <header><CalendarDaysIcon /><h2>Auctions</h2><span className="right"><Link href="/staff/auctions" className="link small">All auctions</Link></span></header>
          <div className="body flush">
            {[...live, ...upcoming].length === 0 ? <div className="empty"><CalendarDaysIcon /><b>No auctions open or scheduled</b></div> : (
              <table className="table">
                <thead><tr><th>Auction</th><th>Status</th><th className="r">Lots</th><th className="r">Bids</th><th className="r">First close</th></tr></thead>
                <tbody>{[...live, ...upcoming].slice(0, 6).map((a) => (
                  <tr key={a.id}>
                    <td><span className="w500">{a.title}</span><br /><span className="micro">{a.code}</span></td>
                    <td><span className={`status ${a.status === 'open' ? 'good' : 'neutral'}`}>{a.status === 'open' ? <span className="ring" style={{ background: 'currentColor' }} /> : <span className="ring" />}{words(a.status)}</span></td>
                    <td className="r mono">{a.lots}</td>
                    <td className="r mono">{a.bids}</td>
                    <td className="r small">{shortDateTime(a.firstCloseAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </section>

        <section className="pnl c-6">
          <header><EyeIcon /><h2>Viewings today</h2><span className="badge">{dash?.viewings.length ?? 0}</span></header>
          <div className="body flush">
            {(dash?.viewings ?? []).length === 0 ? <div className="empty"><EyeIcon /><b>No viewings booked today</b></div> : (
              <table className="table">
                <thead><tr><th>Time</th><th>Branch</th><th>Lot</th><th className="r">Booked</th></tr></thead>
                <tbody>{dash!.viewings.map((v) => (
                  <tr key={v.slotId}><td className="mono small">{shortDateTime(v.startsAt)}</td><td>{v.branch}</td><td className="small">{v.lotRef ?? 'Any lot'}</td><td className="r mono">{v.booked}/{v.capacity}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </section>

        <section className="pnl c-6">
          <header><DocumentTextIcon /><h2>Vehicle titles past their deadline</h2>{(dash?.titleCasesOverdue.length ?? 0) > 0 && <span className="badge urgent">{dash!.titleCasesOverdue.length}</span>}</header>
          <div className="body flush">
            {(dash?.titleCasesOverdue ?? []).length === 0 ? <div className="empty"><DocumentTextIcon /><b>Every title is on time</b><span>Change-of-ownership steps past their deadline appear here.</span></div> : (
              <table className="table">
                <thead><tr><th>Lot</th><th>Buyer</th><th>Next step</th><th className="r">Deadline</th></tr></thead>
                <tbody>{dash!.titleCasesOverdue.map((t) => (
                  <tr key={t.titleCaseId}><td><span className="w500">{t.title}</span><br /><span className="micro">{t.lotRef}</span></td><td>{t.buyer}</td><td className="small">{words(t.nextStep)}</td><td className="r small" style={{ color: 'var(--bad)' }}>{shortDateTime(t.deadlineAt)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
