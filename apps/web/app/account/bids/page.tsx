import { ChevronRightIcon, HandRaisedIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { Countdown } from '@/components/Countdown';
import { apiOrNull } from '@/lib/api';
import type { LotCard, MyBid } from '@/lib/types';

export const metadata = { title: 'My bids' };

const STATUS: Record<MyBid['status'], [string, string]> = {
  leading: ['Leading', 'good'],
  outbid: ['Outbid', 'bad'],
  won: ['Won', 'info'],
  lost: ['Not won', 'neutral'],
};

const ORDER: MyBid['status'][] = ['outbid', 'leading', 'won', 'lost'];

export default async function MyBidsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const [bids, lots] = await Promise.all([apiOrNull<MyBid[]>('/me/bids'), apiOrNull<{ lots: LotCard[] }>('/lots')]);
  const all = bids ?? [];
  const covers = new Map((lots?.lots ?? []).map((l) => [l.ref, l.cover]));
  const counts = Object.fromEntries(ORDER.map((s) => [s, all.filter((b) => b.status === s).length])) as Record<MyBid['status'], number>;
  const shown = (status && ORDER.includes(status as MyBid['status']) ? all.filter((b) => b.status === status) : all).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const leadingTotal = all.filter((b) => b.status === 'leading').length;

  return (
    <>
      <div className="acc-title">
        <div>
          <h1>My bids</h1>
          <p>Outbid lots come first. Your maximum is private; we bid for you up to it.</p>
        </div>
        <Link href="/auctions" className="btn ghost">Browse the docket <ChevronRightIcon /></Link>
      </div>
      <div className="kpis" style={{ ['--n' as string]: 4, marginBottom: 16 }}>
        <div className="kpi"><span className="micro">Leading</span><span className="v">{leadingTotal}</span></div>
        <div className="kpi"><span className="micro">Outbid</span><span className={`v${counts.outbid ? ' urgent' : ''}`}>{counts.outbid}</span></div>
        <div className="kpi"><span className="micro">Won</span><span className="v">{counts.won}</span></div>
        <div className="kpi"><span className="micro">Lots bid on</span><span className="v">{all.length}</span></div>
      </div>
      <nav className="seg-tabs" aria-label="Filter by status" style={{ marginBottom: 12 }}>
        <Link href="/account/bids" className={!status ? 'on' : ''}>All <span className="badge">{all.length}</span></Link>
        {ORDER.map((s) => <Link key={s} href={`/account/bids?status=${s}`} className={status === s ? 'on' : ''}>{STATUS[s][0]} <span className={`badge${s === 'outbid' && counts.outbid ? ' urgent' : ''}`}>{counts[s]}</span></Link>)}
      </nav>
      <div className="card" style={{ overflowX: 'auto' }}>
        {shown.length === 0 ? (
          <div className="empty"><HandRaisedIcon /><h3 className="w600">No bids here</h3><p>When you bid, each lot appears here with where you stand.</p><Link className="btn sm" href="/auctions">Find a lot</Link></div>
        ) : (
          <table className="table">
            <thead><tr><th>Lot</th><th>Status</th><th className="r">Current price</th><th className="r">Your maximum</th><th>Ends</th><th /></tr></thead>
            <tbody>
              {shown.map((b) => {
                const [text, tone] = STATUS[b.status];
                const open = b.status === 'leading' || b.status === 'outbid';
                const cover = covers.get(b.ref);
                return (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/lots/${encodeURIComponent(b.ref)}`} className="thumbcell">
                        {cover ? <img src={`${cover}?w=800`} alt="" /> : <span style={{ width: 64, height: 44, borderRadius: 6, background: 'var(--paper-2)' }} />}
                        <span><span className="w500">{b.title}</span><br /><span className="micro">{b.ref}</span></span>
                      </Link>
                    </td>
                    <td><span className={`status ${tone}`}>{tone === 'neutral' ? <span className="ring" /> : <span className="ring" style={{ background: 'currentColor' }} />}{text}</span></td>
                    <td className="r mono">{b.currentPrice?.text ?? '—'}</td>
                    <td className="r mono">{b.yourMax?.text ?? '—'}</td>
                    <td>{open ? <Countdown endsAt={b.endsAt} /> : <span className="muted small">Closed</span>}</td>
                    <td className="r">{b.status === 'outbid' && <Link className="btn sm" href={`/lots/${encodeURIComponent(b.ref)}`}>Bid again</Link>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
