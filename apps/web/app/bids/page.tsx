import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Countdown } from '@/components/Countdown';
import { Topbar } from '@/components/Topbar';
import { apiOrNull } from '@/lib/api';
import type { Me, MyBid } from '@/lib/types';

export const metadata = { title: 'My bids' };

const STATUS: Record<MyBid['status'], [string, string]> = {
  leading: ['Leading', 'good'],
  outbid: ['Outbid', 'bad'],
  won: ['Won', 'info'],
  lost: ['Not won', 'muted'],
};

export default async function BidsPage() {
  const me = await apiOrNull<Me>('/me');
  if (!me) redirect('/sign-in?next=/bids');
  const bids = (await apiOrNull<MyBid[]>('/me/bids')) ?? [];
  return (
    <>
      <Topbar title="My bids" sub="Lots you have bid on. Outbid lots show first among those still open." me={me} />
      <div className="content">
        <div className="card" style={{ overflowX: 'auto' }}>
          {bids.length === 0 ? (
            <div className="empty">You have not bid yet. <Link href="/auctions" style={{ color: 'var(--accent)' }}>Browse live lots</Link>.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Lot</th><th>Status</th><th>Current price</th><th>Your maximum</th><th>Ends</th><th /></tr></thead>
              <tbody>
                {[...bids].sort((a, b) => Number(b.status === 'outbid') - Number(a.status === 'outbid')).map((b) => {
                  const [text, tone] = STATUS[b.status];
                  const open = b.status === 'leading' || b.status === 'outbid';
                  return (
                    <tr key={b.id}>
                      <td><Link href={`/lots/${encodeURIComponent(b.ref)}`}><strong>{b.title}</strong><div className="small muted">{b.ref}</div></Link></td>
                      <td><span className={`pill ${tone}`}>{text}</span></td>
                      <td><strong>{b.currentPrice?.text ?? '—'}</strong></td>
                      <td>{b.yourMax?.text ?? '—'}</td>
                      <td>{open ? <Countdown endsAt={b.endsAt} /> : <span className="muted">Closed</span>}</td>
                      <td>{b.status === 'outbid' && <Link className="btn soft" href={`/lots/${encodeURIComponent(b.ref)}`}>Bid again</Link>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
