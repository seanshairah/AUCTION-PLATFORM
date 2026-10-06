import { CalendarDaysIcon, PlayIcon, PlusIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { Action } from '@/components/staff/Action';
import { ScheduleAuction } from '@/components/staff/ScheduleAuction';
import { apiOrNull } from '@/lib/api';
import { shortDateTime } from '@/lib/format';
import { can, staffMe, words } from '@/lib/staff';

export const metadata = { title: 'Auctions' };

interface StaffAuction { id: string; code: string; title: string; branch: string; status: string; opensAt: string; firstCloseAt: string; staggerSeconds: number; depositRequired: boolean; lots: number; bids: number }
interface Lot { id: string; ref: string; title: string; branch: string; state: string; seller: string; startingBid: { text: string } }

const BRANCHES = [{ code: 'HRE', name: 'ABC Auctions Harare' }, { code: 'BYO', name: 'ABC Auctions Bulawayo' }];
const TONE: Record<string, string> = { open: 'good', closing: 'warn', scheduled: 'info', draft: 'neutral', closed: 'neutral', cancelled: 'bad' };

export default async function AuctionsPage() {
  const me = (await staffMe())!;
  const schedule = can(me, 'auction.schedule');
  const [auctions, lots] = await Promise.all([apiOrNull<StaffAuction[]>('/staff/auctions'), schedule ? apiOrNull<Lot[]>('/staff/lots/offerable') : null]);
  return (
    <>
      <div className="con-title">
        <div>
          <span className="eyebrow"><CalendarDaysIcon /> Deliverable 18 · Scheduling</span>
          <h1>Auctions</h1>
          <p>Timed auctions with staggered closes and soft-close extensions. An auction pins the rule set in force when it opens, so a mid-sale rule change never moves a buyer’s total.</p>
        </div>
      </div>
      <div className="cgrid">
        <section className={`pnl ${schedule ? 'c-7' : 'c-12'}`}>
          <header><CalendarDaysIcon /><h2>All auctions</h2><span className="badge">{auctions?.length ?? 0}</span></header>
          <div className="body flush">
            {(auctions ?? []).length === 0 ? <div className="empty"><CalendarDaysIcon /><b>No auctions yet</b></div> : (
              <table className="table">
                <thead><tr><th>Auction</th><th>Status</th><th className="r">Lots</th><th className="r">Bids</th><th>Closes</th><th /></tr></thead>
                <tbody>{auctions!.map((a) => (
                  <tr key={a.id}>
                    <td><span className="w500">{a.title}</span><br /><span className="micro">{a.code} · {a.branch}{a.depositRequired ? ' · deposit' : ''}</span></td>
                    <td><span className={`status ${TONE[a.status] ?? 'neutral'}`}><span className="ring" style={a.status === 'open' ? { background: 'currentColor' } : undefined} /> {words(a.status)}</span></td>
                    <td className="r mono">{a.lots}</td>
                    <td className="r mono">{a.bids}</td>
                    <td className="small">{shortDateTime(a.firstCloseAt)}<br /><span className="muted">{a.staggerSeconds ? `+${a.staggerSeconds / 60} min per lot` : 'Together'}</span></td>
                    <td className="r">
                      {schedule && (a.status === 'scheduled' || a.status === 'draft') && a.lots > 0
                        ? <Action url={`/staff/auctions/${a.id}/open`} label="Open" tone="ink" icon={<PlayIcon />} confirm={`Open ${a.code}? Bidding starts at its opening time under the rule set in force.`} done="Opened." />
                        : a.status === 'open' ? <Link href="/auctions" className="link small">View</Link> : null}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </section>
        {schedule && (
          <section className="pnl c-5">
            <header><PlusIcon /><h2>Schedule an auction</h2></header>
            <div className="body"><ScheduleAuction lots={lots ?? []} branches={BRANCHES} /></div>
          </section>
        )}
      </div>
    </>
  );
}
